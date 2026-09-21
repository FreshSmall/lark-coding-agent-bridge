import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-store-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'sessions.json');
}

describe('thread-context injection marker', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('reports a thread as un-injected until it is marked', async () => {
    const store = new SessionStore(await storePath());

    expect(store.hasInjectedThreadContext('oc_chat', 'omt_1')).toBe(false);
    store.markThreadContextInjected('oc_chat', 'omt_1');
    expect(store.hasInjectedThreadContext('oc_chat', 'omt_1')).toBe(true);
  });

  // An ordinary group keeps ONE scope for every thread in it (scopeFor only
  // splits by thread for real 话题群), so a scope-keyed marker would make the
  // first thread in a group suppress every later one.
  it('keys the marker by thread, not just by scope', async () => {
    const store = new SessionStore(await storePath());

    store.markThreadContextInjected('oc_chat', 'omt_1');

    expect(store.hasInjectedThreadContext('oc_chat', 'omt_2')).toBe(false);
  });

  it('keeps threads of different scopes apart', async () => {
    const store = new SessionStore(await storePath());

    store.markThreadContextInjected('oc_a', 'omt_1');

    expect(store.hasInjectedThreadContext('oc_b', 'omt_1')).toBe(false);
  });

  it('drops every thread marker of a scope on clear', async () => {
    const store = new SessionStore(await storePath());
    store.set('oc_chat', 'sess-1', '/repo');
    store.markThreadContextInjected('oc_chat', 'omt_1');
    store.markThreadContextInjected('oc_chat', 'omt_2');

    store.clear('oc_chat');

    expect(store.hasInjectedThreadContext('oc_chat', 'omt_1')).toBe(false);
    expect(store.hasInjectedThreadContext('oc_chat', 'omt_2')).toBe(false);
  });

  it('leaves other scopes alone on clear', async () => {
    const store = new SessionStore(await storePath());
    store.markThreadContextInjected('oc_a', 'omt_1');
    store.markThreadContextInjected('oc_b', 'omt_1');

    store.clear('oc_a');

    expect(store.hasInjectedThreadContext('oc_b', 'omt_1')).toBe(true);
  });

  it('drops the marker on clear even when the scope has no session entry', async () => {
    // A run that injected the thread but failed before recording a session id
    // leaves a marker with no entry behind it. `clear` early-returns on a
    // missing entry, so the marker has to be dropped before that return —
    // otherwise `/new` silently fails to re-inject.
    const store = new SessionStore(await storePath());
    store.markThreadContextInjected('oc_chat', 'omt_1');

    store.clear('oc_chat');

    expect(store.hasInjectedThreadContext('oc_chat', 'omt_1')).toBe(false);
  });

  it('does not persist the marker across a reload', async () => {
    const path = await storePath();
    const store = new SessionStore(path);
    store.set('oc_chat', 'sess-1', '/repo');
    store.markThreadContextInjected('oc_chat', 'omt_1');
    await store.flush();

    const reloaded = new SessionStore(path);
    await reloaded.load();

    expect(reloaded.resumeFor('oc_chat', '/repo')).toBe('sess-1');
    expect(reloaded.hasInjectedThreadContext('oc_chat', 'omt_1')).toBe(false);
  });
});
