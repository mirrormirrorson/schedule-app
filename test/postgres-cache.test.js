const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore } = require('../server');

function seedState() {
  return {
    groups: [{ id: 'g1', name: '测试组' }],
    schedules: {},
    _revision: 7,
    _updated: Date.now(),
  };
}

test('cached state, users and history do not query Postgres', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => { queryCount += 1; throw new Error('unexpected database query'); },
    connect: async () => { throw new Error('unexpected database connection'); },
    end: async () => {},
  };
  const store = new PostgresStore('postgresql://localhost/test', {}, { pool });
  store.setStateCache(seedState());
  store.setUsersCache([{
    id: 'u1', name: '测试人员', first_seen_at: new Date(), last_seen_at: new Date(),
    can_score_radar: false, can_manage_radar_fields: false,
  }]);
  store.setHistoryCache([{
    id: 'h1', ts: new Date().toISOString(), user: '测试人员', group: '测试组', content: '内容',
  }]);

  const state = await store.getState();
  state.groups[0].name = '被调用方修改';
  assert.equal((await store.getState()).groups[0].name, '测试组');
  assert.equal((await store.getMeta())._revision, 7);
  assert.equal((await store.listUsers()).length, 1);
  assert.equal((await store.getUserById('u1')).name, '测试人员');
  assert.equal((await store.listHistory({ group: '测试组', user: '', query: '', limit: 8000 })).length, 1);
  assert.equal((await store.identify('测试人员')).id, 'u1');
  assert.equal(queryCount, 0);
});

test('normal patch locks only metadata and returns state from memory', async () => {
  const sql = [];
  const client = {
    async query(text) {
      sql.push(text);
      if (/SELECT revision, updated_at FROM app_state/.test(text)) {
        return { rowCount: 1, rows: [{ revision: 7, updated_at: new Date() }] };
      }
      if (/SELECT revision FROM mutations/.test(text)) return { rowCount: 0, rows: [] };
      if (/UPDATE app_state/.test(text)) {
        return { rowCount: 1, rows: [{ revision: 8, updated_at: new Date() }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query, end: async () => {} };
  const store = new PostgresStore('postgresql://localhost/test', {}, { pool });
  store.setStateCache(seedState());
  store.lastMutationCleanupAt = Date.now();

  const result = await store.applyPatch({
    mutationId: 'mutation-cache-test',
    changes: [{
      path: ['groups'],
      before: { exists: true, value: [{ id: 'g1', name: '测试组' }] },
      after: { exists: true, value: [{ id: 'g1', name: '新名称' }] },
    }],
    historyEntries: [],
  });

  assert.equal(result.state._revision, 8);
  assert.equal(result.state.groups[0].name, '新名称');
  assert.equal(sql.some(text => /SELECT data/.test(text)), false);
  const updateSql = sql.find(text => /UPDATE app_state/.test(text));
  assert.doesNotMatch(updateSql, /RETURNING\s+data/i);
});
