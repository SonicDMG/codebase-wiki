'use client';

import { useEffect, useRef } from 'react';

export function ConfirmRebuildDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus to Cancel on open; restore on close.
  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      // Simple focus trap: Tab / Shift+Tab wraps inside the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled'));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      // Click on backdrop closes.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="rebuild-dialog-title"
        aria-describedby="rebuild-dialog-desc"
        style={{
          background: 'var(--w-bg, #ffffff)',
          border: '1px solid var(--w-border, #e5e7eb)',
          borderRadius: '10px',
          padding: '28px 28px 20px',
          maxWidth: '420px',
          width: '90vw',
          color: 'var(--w-text, #1f2328)',
          fontFamily: 'var(--w-fontBody, -apple-system, "Segoe UI", system-ui, sans-serif)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <h2
          id="rebuild-dialog-title"
          style={{ margin: '0 0 12px', fontSize: '17px', fontWeight: 600, lineHeight: 1.3 }}
        >
          Rebuild the whole wiki?
        </h2>
        <p
          id="rebuild-dialog-desc"
          style={{
            margin: '0 0 24px',
            fontSize: '14px',
            lineHeight: 1.6,
            color: 'var(--w-textMuted, #57606a)',
          }}
        >
          This designs a new topic list and regenerates every page from scratch. It takes several
          minutes and uses AI credits. The current wiki stays in place until the new one is ready.
          If you stop it, nothing changes.
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              fontSize: '13px',
              padding: '7px 18px',
              borderRadius: '6px',
              border: '1px solid var(--w-border, #e5e7eb)',
              background: 'var(--w-surface, #f7f8fa)',
              color: 'var(--w-text, #1f2328)',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              fontSize: '13px',
              padding: '7px 18px',
              borderRadius: '6px',
              border: '1px solid #b35900',
              background: '#b35900',
              color: '#ffffff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Rebuild from scratch
          </button>
        </div>
      </div>
    </div>
  );
}
