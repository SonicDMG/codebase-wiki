'use client';

/** Slim, non-modal bar offering a regenerated version of the page being read. */
export function NewVersionBanner({ onSwitch, onDismiss }: { onSwitch: () => void; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        padding: '8px 12px',
        marginBottom: '16px',
        background: 'var(--w-amberLight, #fff7e6)',
        border: '1px solid var(--w-amberBorder, #fcd389)',
        borderRadius: '6px',
        color: 'var(--w-text, #1a1a1f)',
        fontSize: '13px',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>A newer version of this page is ready.</span>
      <button
        type="button"
        onClick={onSwitch}
        style={{
          background: 'var(--w-amber, #F5A623)',
          color: 'var(--w-onAccent, #1a1a1f)',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 12px',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Switch to new version
      </button>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: 'transparent',
          color: 'var(--w-textMuted, #57606a)',
          border: '1px solid var(--w-border, #e2e4e8)',
          borderRadius: '4px',
          padding: '4px 12px',
          fontSize: '13px',
          cursor: 'pointer',
        }}
      >
        Later
      </button>
    </div>
  );
}
