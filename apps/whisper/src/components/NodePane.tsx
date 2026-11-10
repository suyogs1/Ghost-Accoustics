import { useState } from 'react';
import type { WhisperNode } from '../hooks/useWhisperNode';
import { hex8, parseNodeId } from '../whisper/text';
import { ChatStream } from './ChatStream';
import { TelemetryPanel } from './TelemetryPanel';

interface IdFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly readOnly: boolean;
  readonly onChange: (value: number) => void;
}

/** Hex node ID input (1..255) that only commits valid values. */
function IdField({ id, label, value, readOnly, onChange }: IdFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? hex8(value);
  const invalid = draft !== null && parseNodeId(draft) === null;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`id-input ${invalid ? 'is-invalid' : ''}`}
        value={shown}
        readOnly={readOnly}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = parseNodeId(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        onBlur={() => setDraft(null)}
      />
      <span id={`${id}-hint`} className="hint">
        {invalid ? 'Hex 0x01 to 0xFF' : readOnly ? 'fixed in simulation' : 'hex, 0x01 to 0xFF'}
      </span>
    </div>
  );
}

interface Props {
  readonly title: string;
  readonly idPrefix: string;
  readonly node: WhisperNode;
  readonly nodeId: number;
  readonly targetId: number;
  readonly loopback: boolean;
  readonly onNodeId: (value: number) => void;
  readonly onTargetId: (value: number) => void;
}

export function NodePane({ title, idPrefix, node, nodeId, targetId, loopback, onNodeId, onTargetId }: Props) {
  const ready = node.status === 'ready';
  const sameId = nodeId === targetId;

  return (
    <section className="pane" aria-label={title}>
      <header className="pane-head">
        <h2 className="pane-title">{title}</h2>
        <span className={`chip ${ready ? 'chip-ok' : ''}`}>
          {node.status === 'ready' ? 'radio on' : node.status === 'starting' ? 'starting...' : 'radio off'}
        </span>
      </header>

      <div className="card config" aria-label="Node configuration">
        <h3 className="card-title">Node configuration</h3>
        <div className="config-fields">
          <IdField id={`${idPrefix}-me`} label="My Node ID" value={nodeId} readOnly={loopback} onChange={onNodeId} />
          <IdField id={`${idPrefix}-target`} label="Target Peer ID" value={targetId} readOnly={loopback} onChange={onTargetId} />
        </div>
        {sameId && <p className="alert alert-warn">Node ID and target are the same, so nothing can be delivered.</p>}
        {!loopback && !ready && (
          <button
            type="button"
            className="btn btn-primary btn-wide"
            disabled={node.status === 'starting'}
            onClick={() => void node.start()}
          >
            {node.status === 'starting' ? 'Starting...' : 'Start radio (speaker + microphone)'}
          </button>
        )}
        {node.error && (
          <p className="alert alert-error" role="alert">
            {node.error}
          </p>
        )}
        {node.warning && <p className="alert alert-warn">{node.warning}</p>}
      </div>

      <ChatStream messages={node.messages} canSend={ready && !sameId} onSend={node.send} />
      <TelemetryPanel metrics={node.metrics} linkState={node.linkState} loopback={loopback} />
    </section>
  );
}
