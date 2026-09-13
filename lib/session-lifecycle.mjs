// Interruption cancels new work, while preserving the transport for cleanup.
export class SessionLifecycle {
  interrupted = false;
  stopping = false;
  #closeInput;
  #closeTransport;
  #record;
  #transportClosed = false;

  constructor({ closeInput, closeTransport, record = () => {} }) {
    this.#closeInput = closeInput;
    this.#closeTransport = closeTransport;
    this.#record = record;
  }

  interrupt(signal) {
    this.interrupted = true;
    this.#record('signal-received', { signal, phase: this.stopping ? 'cleanup' : 'trial' });
    this.#closeInput();
  }

  check() {
    if (this.interrupted && !this.stopping) throw new Error('Session interrupted.');
  }

  beginCleanup() {
    if (this.stopping) return false;
    this.stopping = true;
    this.#record('cleanup-start');
    return true;
  }

  closeTransport() {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    this.#record('transport-close');
    this.#closeTransport();
  }
}
