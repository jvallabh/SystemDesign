import { useEffect, useMemo, useRef, useState } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from './corpus';
import type { Corpus, CorpusTopic } from './corpus';
import { renderMarkdown } from './markdown';
import type { TitleFor } from './markdown';
import { qaSystem, interviewSystem, FEEDBACK_REQUEST } from './prompts';
import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';
import { makeClient, streamTurn, READ_TOPIC_TOOL, MODELS, DEFAULT_MODEL } from './api';
import './tutor.css';

const STORAGE_KEY = 'tutor:api-key';
const STORAGE_MODEL = 'tutor:model';

type Mode = 'ask' | 'interview';

interface UiMsg {
  id: string;
  role: 'user' | 'assistant' | 'note';
  text: string;
  streaming?: boolean;
  stopped?: boolean;
}

export default function Tutor() {
  const [apiKey, setApiKey] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [keyInput, setKeyInput] = useState('');
  const [keyPanelOpen, setKeyPanelOpen] = useState<boolean>(() => !localStorage.getItem(STORAGE_KEY));
  const [model, setModel] = useState<string>(() => localStorage.getItem(STORAGE_MODEL) || DEFAULT_MODEL);

  const [mode, setMode] = useState<Mode>('ask');
  const [scenario, setScenario] = useState<Scenario | null>(null);

  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [corpusError, setCorpusError] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  const newId = () => `m${idRef.current++}`;

  const client = useMemo(() => (apiKey ? makeClient(apiKey) : null), [apiKey]);

  // Load the corpus once (lazy, memoized in module scope).
  useEffect(() => {
    let alive = true;
    loadCorpus().then(
      (c) => alive && setCorpus(c),
      () => alive && setCorpusError('Could not load the Atlas corpus. Reload the page to try again.'),
    );
    return () => {
      alive = false;
    };
  }, []);

  // Autoscroll to the newest message.
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    endRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' });
  }, [transcript]);

  const qaIndex = useMemo(() => {
    if (!corpus) return '';
    return corpus.topics
      .map((t) => `${t.id} — ${t.title} — ${t.summary}${t.sim ? ' [sim]' : ''}`)
      .join('\n');
  }, [corpus]);

  const titleFor = useMemo<TitleFor>(() => {
    const map = new Map<string, string>((corpus?.topics ?? []).map((t) => [t.id, t.title]));
    return (id) => map.get(id);
  }, [corpus]);

  const interviewTopics = useMemo<CorpusTopic[]>(() => {
    if (!corpus || !scenario) return [];
    const byId = new Map(corpus.topics.map((t) => [t.id, t]));
    return scenario.topicIds
      .map((id) => byId.get(id))
      .filter((t): t is CorpusTopic => t !== undefined);
  }, [corpus, scenario]);

  const readTopic = (id: string): string | null => {
    const t = corpus?.topics.find((x) => x.id === id);
    return t ? t.body : null;
  };

  const hasAnswered = transcript.some((m) => m.role === 'user');

  // --- key management ---
  function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    localStorage.setItem(STORAGE_KEY, k);
    setApiKey(k);
    setKeyInput('');
    setKeyPanelOpen(false);
    setError(null);
  }

  function clearKey() {
    localStorage.removeItem(STORAGE_KEY);
    setApiKey(null);
    setKeyInput('');
    setKeyPanelOpen(true);
  }

  function changeModel(id: string) {
    setModel(id);
    localStorage.setItem(STORAGE_MODEL, id);
  }

  // --- conversation control ---
  // Abort any in-flight turn and relinquish ownership of abortRef so that
  // turn's catch/finally become no-ops (see the stale() guard in runTurn).
  // Used by actions that supersede the current conversation.
  function abortActive() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setBusy(false);
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    abortActive();
    setMode(next);
    setScenario(null);
    setTranscript([]);
    setError(null);
    historyRef.current = [];
  }

  function selectScenario(s: Scenario) {
    abortActive();
    setScenario(s);
    historyRef.current = [];
    setTranscript([{ id: newId(), role: 'assistant', text: s.opening }]);
    setError(null);
  }

  function leaveScenario() {
    abortActive();
    setScenario(null);
    setTranscript([]);
    historyRef.current = [];
    setError(null);
  }

  // Stop button: abort but keep ownership so the partial answer is committed.
  function stop() {
    abortRef.current?.abort();
  }

  function handleError(e: unknown) {
    if (e instanceof Anthropic.AuthenticationError) {
      setError('Invalid API key. Check the key and try again.');
      setKeyPanelOpen(true);
    } else if (e instanceof Anthropic.RateLimitError) {
      setError('Rate limited — wait a moment and retry.');
    } else if (e instanceof Anthropic.APIConnectionError) {
      setError('Network error reaching api.anthropic.com. Check your connection and retry.');
    } else if (e instanceof Anthropic.APIError) {
      setError(`API error${e.status ? ` (${e.status})` : ''}: ${e.message}`);
    } else {
      setError('Something went wrong. Please try again.');
    }
  }

  async function runTurn(apiUserText: string, userEntry: { role: 'user' | 'note'; text: string }) {
    if (!client || !corpus || busy) return;
    if (mode === 'interview' && !scenario) return;

    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);

    // This turn owns abortRef only while it still points at our controller.
    // A superseding action (switchMode / selectScenario / leaveScenario) nulls
    // it via abortActive; once stale, our catch/finally must write nothing.
    const stale = () => abortRef.current !== controller;

    const userMsg: Anthropic.MessageParam = { role: 'user', content: apiUserText };
    const baseHistory: Anthropic.MessageParam[] = [...historyRef.current, userMsg];

    const asstId = newId();
    setTranscript((t) => [
      ...t,
      { id: newId(), role: userEntry.role, text: userEntry.text },
      { id: asstId, role: 'assistant', text: '', streaming: true },
    ]);

    let partial = '';
    // At each new assistant round, clear the displayed + committed text so
    // intermediate tool-round narration ("Let me check…") is not prepended to
    // the final synthesis answer. The structured history sent to the API is
    // unaffected — streamTurn builds that separately.
    const onRoundStart = () => {
      partial = '';
      setTranscript((t) => t.map((m) => (m.id === asstId ? { ...m, text: '' } : m)));
    };
    const onText = (delta: string) => {
      partial += delta;
      setTranscript((t) => t.map((m) => (m.id === asstId ? { ...m, text: partial } : m)));
    };

    try {
      const system =
        mode === 'ask' ? qaSystem(qaIndex) : interviewSystem(scenario!, interviewTopics);
      const appended = await streamTurn({
        client,
        model,
        system,
        history: baseHistory,
        tools: mode === 'ask' ? [READ_TOPIC_TOOL] : undefined,
        readTopic: mode === 'ask' ? readTopic : undefined,
        onRoundStart,
        onText,
        signal: controller.signal,
      });
      if (stale()) return;
      historyRef.current = [...baseHistory, ...appended];
      setTranscript((t) =>
        t.map((m) => (m.id === asstId ? { ...m, streaming: false, text: partial } : m)),
      );
    } catch (e) {
      if (stale()) return; // superseded by a mode/scenario switch — write nothing
      if (e instanceof Anthropic.APIUserAbortError) {
        // Stop button: keep the partial text; commit it so the chat can continue.
        historyRef.current = [
          ...baseHistory,
          { role: 'assistant', content: partial || '(stopped)' },
        ];
        setTranscript((t) =>
          t.map((m) => (m.id === asstId ? { ...m, streaming: false, stopped: true } : m)),
        );
      } else {
        // Commit the user turn so context is preserved, drop the empty bubble.
        historyRef.current = baseHistory;
        setTranscript((t) => t.filter((m) => m.id !== asstId));
        handleError(e);
      }
    } finally {
      if (!stale()) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  }

  function send() {
    const text = input.trim();
    if (!text || busy || !client || !corpus) return;
    setInput('');
    void runTurn(text, { role: 'user', text });
  }

  function endInterview() {
    if (busy || !client || mode !== 'interview' || !scenario || !hasAnswered) return;
    void runTurn(FEEDBACK_REQUEST, {
      role: 'note',
      text: 'Interview ended — scoring against the rubric…',
    });
  }

  const showComposer = mode === 'ask' || scenario !== null;
  const roleLabel = (role: 'user' | 'assistant') =>
    role === 'user' ? 'You' : mode === 'interview' ? 'Interviewer' : 'Tutor';

  return (
    <div className="tutor">
      <div className="tutor-topbar">
        <div className="tutor-tabs" role="tablist" aria-label="Tutor mode">
          <button
            role="tab"
            aria-selected={mode === 'ask'}
            className={mode === 'ask' ? 'active' : ''}
            onClick={() => switchMode('ask')}
            disabled={busy}
          >
            Ask the Atlas
          </button>
          <button
            role="tab"
            aria-selected={mode === 'interview'}
            className={mode === 'interview' ? 'active' : ''}
            onClick={() => switchMode('interview')}
            disabled={busy}
          >
            Mock interview
          </button>
        </div>
        <div className="tutor-controls">
          <label className="tutor-model">
            model
            <select
              value={model}
              onChange={(e) => changeModel(e.target.value)}
              aria-label="Claude model"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {apiKey && (
            <button className="tutor-btn ghost" onClick={() => setKeyPanelOpen((o) => !o)}>
              {keyPanelOpen ? 'Hide key' : 'Key'}
            </button>
          )}
        </div>
      </div>

      {keyPanelOpen && (
        <div className="tutor-keypanel">
          <h2>Bring your own Anthropic key</h2>
          <p className="tutor-trust">
            Your key is stored only in this browser (localStorage) and sent only to
            api.anthropic.com when you chat. It never reaches this site — the Atlas is a static
            site with no server — and it is never logged.
          </p>
          <label className="tutor-key-label" htmlFor="tutor-key-input">
            API key
          </label>
          <div className="tutor-key-row">
            <input
              id="tutor-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveKey();
              }}
            />
            <button className="tutor-btn primary" onClick={saveKey} disabled={!keyInput.trim()}>
              Save key
            </button>
          </div>
          {keyInput.trim() !== '' && !keyInput.trim().startsWith('sk-ant-') && (
            <p className="tutor-hint warn">
              Anthropic keys usually start with <code>sk-ant-</code>. Double-check this is a Claude
              API key.
            </p>
          )}
          {apiKey && (
            <div className="tutor-key-status">
              <span>A key is saved in this browser.</span>
              <button className="tutor-btn ghost" onClick={clearKey}>
                Clear key
              </button>
            </div>
          )}
          <p className="tutor-hint">
            Get a key at{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            . Usage is billed to your own Anthropic account.
          </p>
        </div>
      )}

      {error && (
        <div className="tutor-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {corpusError && (
        <div className="tutor-error" role="alert">
          <span>{corpusError}</span>
        </div>
      )}

      {mode === 'interview' && scenario && (
        <div className="tutor-scenario-bar">
          <span>Interview · {scenario.title}</span>
          <button className="tutor-btn ghost" onClick={leaveScenario} disabled={busy}>
            Change scenario
          </button>
        </div>
      )}

      <div className="tutor-body">
        {mode === 'interview' && !scenario ? (
          <div className="tutor-scenarios">
            <p className="tutor-scenarios-lead">
              Pick a scenario. The interviewer asks one question at a time; when you are done, end
              the interview for rubric-scored feedback with topic citations.
            </p>
            <div className="tutor-scenario-grid">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  className="tutor-scenario"
                  onClick={() => selectScenario(s)}
                  disabled={!corpus || !apiKey || busy}
                >
                  <span className="tutor-scenario-title">{s.title}</span>
                  <span className="tutor-scenario-blurb">Covers {s.topicIds.length} core topics</span>
                </button>
              ))}
            </div>
            {!apiKey && <p className="tutor-hint">Add your API key above to start an interview.</p>}
          </div>
        ) : (
          <div className="tutor-transcript">
            {transcript.length === 0 && mode === 'ask' && (
              <div className="tutor-empty">
                <p>
                  Ask anything about the 30 Atlas topics. The tutor answers only from the articles
                  and cites its sources — questions outside the Atlas are politely declined.
                </p>
                <ul>
                  <li>When should I reach for a CDN instead of an in-memory cache?</li>
                  <li>Explain consistent hashing and why it beats plain mod-N.</li>
                  <li>What does the CAP theorem actually force me to choose?</li>
                </ul>
              </div>
            )}
            {transcript.map((m) => (
              <div key={m.id} className={`tutor-msg tutor-msg-${m.role}`}>
                {m.role === 'note' ? (
                  <div className="tutor-note">{m.text}</div>
                ) : (
                  <>
                    <div className="tutor-msg-role">{roleLabel(m.role)}</div>
                    {m.role === 'assistant' ? (
                      <div className="tutor-md">
                        {renderMarkdown(m.text || '…', titleFor)}
                        {m.streaming && <span className="tutor-caret" aria-hidden="true" />}
                        {m.stopped && <span className="tutor-stopped">⏹ stopped</span>}
                      </div>
                    ) : (
                      <div className="tutor-usertext">{m.text}</div>
                    )}
                  </>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {showComposer && (
        <div className="tutor-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              apiKey
                ? mode === 'ask'
                  ? 'Ask about a system design topic…  (Enter to send, Shift+Enter for a newline)'
                  : 'Type your answer…  (Enter to send, Shift+Enter for a newline)'
                : 'Add your API key above to start.'
            }
            disabled={!apiKey || busy}
            rows={2}
          />
          <div className="tutor-composer-actions">
            {mode === 'interview' && scenario && (
              <button
                className="tutor-btn ghost"
                onClick={endInterview}
                disabled={busy || !apiKey || !hasAnswered}
              >
                End interview &amp; get feedback
              </button>
            )}
            {busy ? (
              <button className="tutor-btn stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button
                className="tutor-btn primary"
                onClick={send}
                disabled={!apiKey || !corpus || !input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
