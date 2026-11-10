import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useFrameClock } from '../hooks/useFrameClock';
import type { ChatMessage } from '../hooks/useWhisperNode';
import { ACK_AIRTIME_SECONDS, MAX_TEXT_BYTES, clampToBytes, encodeText, hex8, wireCost } from '../whisper/text';

const STATUS_LABEL: Record<NonNullable<ChatMessage['status']>, string> = {
  QUEUED: 'QUEUED',
  TRANSMITTING: 'TRANSMITTING',
  DELIVERED: 'DELIVERED / ACKED',
  FAILED: 'FAILED',
};

function TransmitMeter({ message }: { readonly message: ChatMessage }) {
  const airtime = message.phase === 'airtime';
  const now = useFrameClock(airtime);
  const total = message.estimatedSeconds;
  const elapsed = airtime && message.txStartedAt !== undefined ? Math.max(0, (now - message.txStartedAt) / 1000) : total;
  const fraction = airtime ? Math.min(0.99, total > 0 ? elapsed / total : 0) : 1;
  const remaining = Math.max(0, total - elapsed);

  return (
    <div className="meter">
      <div
        className="progress"
        role="progressbar"
        aria-label="Message airtime"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
      >
        <div className={`progress-fill ${airtime ? '' : 'is-waiting'}`} style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className="meter-text">
        {airtime
          ? remaining > 0
            ? `on air, ${remaining.toFixed(1)} s left`
            : 'on air, finishing'
          : 'awaiting ACK'}
        {message.attempt !== undefined && message.maxAttempts !== undefined && ` (try ${message.attempt}/${message.maxAttempts})`}
      </span>
    </div>
  );
}

function Bubble({ message, onRetry }: { readonly message: ChatMessage; readonly onRetry: (text: string) => void }) {
  if (message.direction === 'in') {
    return (
      <li className="bubble bubble-in">
        <p className="bubble-from">from {hex8(message.peer)}</p>
        <p className="bubble-text">{message.text}</p>
        <p className="bubble-meta">
          {message.textBytes} B text, {message.frameBytes} B frame
          {message.measuredAirtime != null && `, heard in ${message.measuredAirtime.toFixed(2)} s`}
          {message.snrDb != null && `, SNR ${message.snrDb.toFixed(1)} dB`}
        </p>
      </li>
    );
  }

  const status = message.status ?? 'QUEUED';
  return (
    <li className={`bubble bubble-out is-${status.toLowerCase()}`}>
      <p className="bubble-from">to {hex8(message.peer)}</p>
      <p className="bubble-text">{message.text}</p>
      <div className="bubble-status">
        <span className={`status status-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>
        {status === 'DELIVERED' && message.rttMs != null && (
          <span className="bubble-meta">
            RTT {Math.round(message.rttMs)} ms
            {message.attempt !== undefined && message.attempt > 1 ? `, after ${message.attempt - 1} retry` : ''}
          </span>
        )}
        {status === 'FAILED' && (
          <>
            <span className="bubble-meta">no ACK after {message.attempt ?? '?'} tries</span>
            <button type="button" className="link" onClick={() => onRetry(message.text)}>
              Retry
            </button>
          </>
        )}
        {status === 'QUEUED' && <span className="bubble-meta">waiting for the radio</span>}
      </div>
      {status === 'TRANSMITTING' && <TransmitMeter message={message} />}
    </li>
  );
}

interface Props {
  readonly messages: readonly ChatMessage[];
  readonly canSend: boolean;
  readonly onSend: (text: string) => void;
}

export function ChatStream({ messages, canSend, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const bytes = encodeText(draft).length;
  const cost = wireCost(bytes);
  const chars = [...draft].length;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!canSend || draft.trim() === '') return;
    onSend(draft);
    setDraft('');
  };

  return (
    <div className="chat">
      <ol className="stream" aria-label="Messages" aria-live="polite">
        {messages.length === 0 && <li className="stream-empty">No messages yet. Type below: each byte costs 0.125 s of airtime.</li>}
        {messages.map((m) => (
          <Bubble key={m.id} message={m} onRetry={onSend} />
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ol>

      <form className="composer" onSubmit={submit}>
        <label htmlFor="composer-input" className="sr-only">
          Message, up to {MAX_TEXT_BYTES} bytes
        </label>
        <input
          id="composer-input"
          className="composer-input"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
          placeholder={canSend ? `Up to ${MAX_TEXT_BYTES} characters` : 'Start the radio first'}
          value={draft}
          disabled={!canSend}
          onChange={(e) => setDraft(clampToBytes(e.target.value))}
        />
        <button type="submit" className="btn btn-primary" disabled={!canSend || draft.trim() === ''}>
          Send
        </button>
      </form>
      <p className="composer-cost" aria-live="polite">
        <strong>
          {bytes}/{MAX_TEXT_BYTES} B
        </strong>{' '}
        ({chars} {chars === 1 ? 'char' : 'chars'}) = {cost.frameBytes} B frame ≈ {cost.airtimeSeconds.toFixed(2)} s airtime
        <span className="muted"> + {ACK_AIRTIME_SECONDS.toFixed(1)} s for the ACK</span>
      </p>
    </div>
  );
}
