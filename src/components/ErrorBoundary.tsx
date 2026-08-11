import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from 'react';
import { CopyIcon, RefreshIcon } from '../layout/icons.tsx';
import { type VersionInfo, versionApi } from '../lib/api.ts';
import { describeError, formatCrashReport } from '../lib/crashReport.ts';
import { recentErrors } from '../lib/errorLog.ts';
import './ErrorBoundary.css';

interface Caught {
  error: unknown;
  componentStack: string | null;
  /** Epoch ms, so the report can say when and drop anything logged after. */
  at: number;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Which part of the app this boundary owns, in the app's own words: 'the chat', 'the
   * left panel'. Omitted at the root, where the answer is "all of it" — that is the only
   * difference between the two, so there is no separate variant prop to keep in step.
   */
  where?: string;
  /**
   * Changing any of these clears a caught error. Navigating away is a recovery path: a
   * card that crashes its editor must not leave the panel dead after you switch to
   * another one. Compared by identity, in order — the useEffect rule.
   */
  resetKeys?: readonly unknown[];
}

interface ErrorBoundaryState {
  /** A wrapper rather than a bare `error`, because `throw undefined` is legal. */
  caught: Caught | null;
}

function sameKeys(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

/**
 * The one thing standing between a thrown exception and a black window.
 *
 * React unmounts the entire tree when a render throws and nothing catches it — not the
 * failing component, the whole thing. Without a boundary that is a blank page with no
 * message, and the reload that a user reaches for reproduces it exactly when the cause is
 * something on disk: an odd field on an imported card, a message that does not parse. The
 * failure mode this exists for is not "the app broke", it is "the app broke and there is
 * nothing to send anyone".
 *
 * Wrapped around the root *and* around each region of the shell, so a crash inside one
 * panel leaves the rest of the app usable and, with `resetKeys`, clears itself the moment
 * you navigate away from whatever caused it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { caught: { error, componentStack: null, at: Date.now() } };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo) {
    // The component stack arrives one phase after the error itself, so it is merged in
    // rather than set — the fallback has already rendered once by now.
    this.setState((state) =>
      state.caught
        ? { caught: { ...state.caught, componentStack: info.componentStack ?? null } }
        : state,
    );
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.caught && !sameKeys(previous.resetKeys, this.props.resetKeys)) {
      this.setState({ caught: null });
    }
  }

  private retry = () => {
    this.setState({ caught: null });
  };

  render() {
    const { caught } = this.state;
    if (!caught) return this.props.children;
    return <CrashScreen caught={caught} where={this.props.where} onRetry={this.retry} />;
  }
}

interface CrashScreenProps {
  caught: Caught;
  where?: string;
  onRetry: () => void;
}

function CrashScreen({ caught, where, onRetry }: CrashScreenProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);

  /*
   * The server is a separate process and a render crash says nothing about it, so it is
   * almost certainly still up. Which build this is — version, branch, commit — is the
   * first thing any report needs and the last thing a user can be expected to know, so
   * ask for it. If the request fails the report simply says the version is unknown.
   */
  useEffect(() => {
    let cancelled = false;
    void versionApi.get().then(
      (info) => {
        if (!cancelled) setVersion(info);
      },
      () => {
        // Nothing to recover: the report has a line for exactly this case.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const report = useMemo(
    () =>
      formatCrashReport({
        error: caught.error,
        componentStack: caught.componentStack,
        where,
        version,
        at: caught.at,
        url: window.location.href,
        userAgent: navigator.userAgent,
        priorErrors: recentErrors(),
      }),
    [caught, where, version],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied('done');
    } catch {
      // Clipboard permission can be refused outright. Open the report so the text is at
      // least selectable by hand — the one thing this screen must never do is strand
      // someone with an error they cannot pass on.
      setCopied('failed');
      setOpen(true);
    }
  }

  // h1 at the root, where this is the only thing on screen; h2 inside a shell that still
  // has a page of its own.
  const Heading = where ? 'h2' : 'h1';

  return (
    <div className="crash" role="alert">
      <div className="crash__card">
        <p className="crash__eyebrow">Error</p>
        <Heading className="crash__title">
          {where ? `Something went wrong in ${where}` : 'Something went wrong'}
        </Heading>
        <p className="crash__lede">
          {where
            ? 'The rest of the app is still running, so you can carry on elsewhere. Nothing on disk was changed — your characters, chats and settings are untouched.'
            : 'WackChatter hit an error while drawing the screen and stopped here rather than show you half an app. Nothing on disk was changed — your characters, chats and settings are untouched.'}
        </p>

        <p className="crash__error">{describeError(caught.error)}</p>

        <div className="crash__actions">
          <button
            type="button"
            className="wc-button wc-button--primary"
            onClick={() => void copy()}
          >
            <CopyIcon />
            {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy report'}
          </button>
          <button type="button" className="wc-button" onClick={onRetry}>
            <RefreshIcon />
            Try again
          </button>
          <button type="button" className="wc-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>

        {/* Folded by default: the report is for sending, not for reading. Controlled so a
            refused clipboard can open it, which is the one case where it must be read. */}
        <details
          className="crash__details"
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary>{open ? 'Hide report' : 'Show report'}</summary>
          <pre className="crash__report">{report}</pre>
        </details>

        <p className="crash__hint">
          {where
            ? 'Try again re-renders it. Closing the panel or switching character clears it too.'
            : 'If reloading brings you straight back here, something in your saved data is causing it — send the report.'}
        </p>
      </div>
    </div>
  );
}
