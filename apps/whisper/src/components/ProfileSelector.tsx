import { ACOUSTIC_PROFILES, PROFILE_ORDER } from '@ghost-acoustics/core/profile';
import type { AcousticProfile } from '@ghost-acoustics/core/profile';

interface Props {
  readonly profile: AcousticProfile;
  readonly onChange: (profile: AcousticProfile) => void;
}

function Ghost() {
  return (
    <svg className="ghost" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M12 2C7.6 2 5 5.3 5 9.4V21l2.4-2 2.3 2 2.3-2 2.3 2 2.3-2 2.4 2V9.4C19 5.3 16.4 2 12 2z"
        fill="currentColor"
      />
      <circle cx="9.3" cy="9.6" r="1.5" fill="#1a0f2b" />
      <circle cx="14.7" cy="9.6" r="1.5" fill="#1a0f2b" />
    </svg>
  );
}

/** Picks how frames are modulated. Both ends of a link must use the same band. */
export function ProfileSelector({ profile, onChange }: Props) {
  const info = ACOUSTIC_PROFILES[profile];
  return (
    <section className={`card profile ${profile === 'haunted-atmosphere' ? 'is-haunted' : ''}`}>
      <div className="field">
        <label htmlFor="profile-select">Transmission profile</label>
        <select id="profile-select" value={profile} onChange={(e) => onChange(e.target.value as AcousticProfile)}>
          {PROFILE_ORDER.map((id) => (
            <option key={id} value={id}>
              {ACOUSTIC_PROFILES[id].label}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        {info.description} Set the same profile on every device.
      </p>
      {profile === 'haunted-atmosphere' && (
        <p className="haunted-note" role="status">
          <Ghost /> Haunted Mask on: a wind howl plays under every transmission.
        </p>
      )}
      {profile === 'silent-ghost' && (
        <p className="hint" role="status">
          Experimental: many phone speakers and microphones barely reproduce 15-19 kHz. Do a range test first.
        </p>
      )}
    </section>
  );
}
