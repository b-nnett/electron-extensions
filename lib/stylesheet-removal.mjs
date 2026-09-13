// Tracks one fixed stylesheet's removal handle. This helper never evaluates code,
// accepts CSS, chooses a target, or relaxes the caller's ownership checks.
export class StylesheetRemoval {
  constructor(persist = async () => {}) {
    this.state = { status: 'not-inserted', key: null };
    this.persist = persist;
  }

  async insert(insert, checkAfter) {
    if (this.state.status !== 'not-inserted') throw new Error('Do not repeat an attempted stylesheet insertion.');
    this.state.status = 'insertion-pending';
    await this.persist();
    try {
      const key = await insert();
      if (typeof key !== 'string' || !key || key.length > 1024) throw new Error('Missing stylesheet removal key.');
      // Capture and persist the handle BEFORE any post-operation check can fail.
      this.state.key = key;
      this.state.status = 'removal-pending';
      await this.persist();
      await checkAfter();
      return key;
    } catch (error) {
      if (!this.state.key) this.state.status = 'application-unknown';
      await this.persist().catch(() => {});
      throw error;
    }
  }

  async remove({ remove, checkAfter, disconnected, reconnect }) {
    if (!this.state.key) return false;
    const attempt = async () => {
      await remove(this.state.key);
      // A removal acknowledgement remains valid if a later ownership/read check fails.
      this.state.key = null;
      this.state.status = 'removed';
      await this.persist();
      await checkAfter();
      return true;
    };
    try { return await attempt(); }
    catch (error) {
      if (!this.state.key || !disconnected()) throw error;
      // Only cleanup can reconnect, once; reconnect must recheck the same owner.
      await reconnect();
      return attempt();
    }
  }
}
