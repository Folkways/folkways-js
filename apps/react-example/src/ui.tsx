import type { ReactNode } from 'react';

/** The Folkways F / node mark in its tile. `small` uses the heavier cut for 48px and below. */
export function LogoTile({ size = 32 }: { size?: number }) {
  const small = size <= 48;
  return (
    <span className="tile" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 406 406" fill="none" stroke="currentColor">
        {small ? (
          <>
            <circle cx="161.7" cy="217.5" r="27" strokeWidth="34" />
            <circle cx="159" cy="306.5" r="21" strokeWidth="30" />
            <circle cx="159.4" cy="114.4" r="33" strokeWidth="34" />
            <path d={TAB} strokeWidth="28" />
            <circle cx="259.4" cy="207.5" r="21" strokeWidth="30" />
            <line x1="188.7" y1="220.9" x2="238" y2="209.8" strokeWidth="30" />
            <line x1="158.2" y1="183" x2="158.5" y2="144" strokeWidth="34" />
            <line x1="157.3" y1="283" x2="157.6" y2="244" strokeWidth="34" />
          </>
        ) : (
          <>
            <circle cx="161.747" cy="217.52" r="28.158" strokeWidth="20" />
            <circle cx="159.051" cy="306.47" r="23.5264" strokeWidth="14" />
            <circle cx="159.4" cy="114.4" r="35" strokeWidth="20" />
            <path d={TAB} strokeWidth="14" />
            <circle cx="259.432" cy="207.52" r="23.5264" strokeWidth="14" />
            <line x1="188.741" y1="220.853" x2="238.065" y2="209.846" strokeWidth="14" />
            <line x1="158.146" y1="183.094" x2="158.478" y2="144.174" strokeWidth="20" />
            <line x1="157.294" y1="283.064" x2="157.626" y2="244.144" strokeWidth="20" />
          </>
        )}
      </svg>
    </span>
  );
}

const TAB =
  'M260.792 90.6846C273.785 90.6846 284.318 101.218 284.318 114.211C284.318 117.482 283.66 119.451 282.92 120.681C282.205 121.871 281.117 122.865 279.363 123.702C275.437 125.576 269.302 126.185 260.792 126.185C256.632 126.185 253.661 126.047 251.451 125.684C249.263 125.324 248.426 124.833 248.096 124.567C247.644 124.203 246.265 122.725 246.265 114.211C246.265 106.177 247.424 100.082 249.728 96.1944C251.661 92.934 254.671 90.6846 260.792 90.6846Z';

export function Wordmark() {
  return (
    <span className="brand">
      <LogoTile />
      <span className="wordmark">folkways</span>
    </span>
  );
}

export function Avatar({ name, me = false, size = 32 }: { name: string; me?: boolean; size?: number }) {
  return (
    <span className={`avatar${me ? ' me' : ''}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The brand's "stitch": a line with amber beads, used as a section marker. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="eyebrow">
      <span className="stitch" aria-hidden="true" />
      {children}
    </p>
  );
}
