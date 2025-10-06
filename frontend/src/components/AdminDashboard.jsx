import React, { useEffect, useMemo, useState } from 'react';

export default function AdminDashboard() {
  const [secret, setSecret] = useState(() => localStorage.getItem('adminSecret') || '');
  const [editingSecret, setEditingSecret] = useState(secret);
  const [authUser, setAuthUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('adminAuth') || 'null'); } catch { return null; }
  });
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bulkText, setBulkText] = useState('');

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    ...(secret ? { 'x-admin-secret': secret } : {}),
    ...(authUser ? { 'x-admin-user': authUser.username, 'x-admin-pass': authUser.password || '' } : {})
  }), [secret, authUser]);

  const loadUsers = async () => {
    setLoading(true); setError('');
    try {
      const resp = await fetch('/api/admin/users', { headers });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'load failed');
      setUsers(data.users || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally { setLoading(false); }
  };

  useEffect(() => { if (secret && authUser) loadUsers(); }, [secret, authUser]);

  const saveSecret = () => {
    setSecret(editingSecret.trim());
    try { localStorage.setItem('adminSecret', editingSecret.trim()); } catch (_) {}
  };

  const doLogin = async (e) => {
    e?.preventDefault?.();
    // 简化：前端校验用户名密码（生产建议走后端登录交换 token）。
    const u = (loginForm.username || '').trim();
    const p = (loginForm.password || '').trim();
    if (!u || !p) { alert('请输入账号与密码'); return; }
    // 使用 env 中的 ADMIN_USER/ADMIN_PASS（由后端注入页面不方便，这里采用本地固定密钥方式：需要在保存 Secret 后再登录）
    if (!secret) { alert('请先填写 Admin Secret 并保存'); return; }
    const auth = { username: u, password: p, ts: Date.now() };
    setAuthUser(auth);
    try { localStorage.setItem('adminAuth', JSON.stringify(auth)); } catch (_) {}
  };

  const logout = () => {
    setAuthUser(null);
    try { localStorage.removeItem('adminAuth'); } catch (_) {}
  };

  const parseIds = (txt) => {
    if (!txt) return [];
    const parts = String(txt).split(/[\s,;，；\n]+/).map(s => s.trim()).filter(Boolean);
    return Array.from(new Set(parts.filter(p => /^(\d{5,})$/.test(p))));
  };

  const bulkInitAndSvip = async () => {
    const ids = parseIds(bulkText);
    if (!ids.length) { alert('请输入至少一个 Telegram ID'); return; }
    setLoading(true); setError('');
    try {
      // 1) Ensure these users exist
      const q = encodeURIComponent(ids.join(','));
      const resp = await fetch(`/api/admin/users?seedIds=${q}`, { headers });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'seed failed');
      // 2) Set plan to svip for each
      for (const id of ids) {
        const r = await fetch('/api/admin/users/setPlan', { method: 'POST', headers, body: JSON.stringify({ userId: id, plan: 'svip' }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error || `setPlan failed for ${id}`);
      }
      await loadUsers();
      alert('已完成：批量初始化并开通 SVIP');
    } catch (e) {
      setError(e.message || String(e));
    } finally { setLoading(false); }
  };

  const setPlan = async (userId, plan) => {
    try {
      const resp = await fetch('/api/admin/users/setPlan', { method: 'POST', headers, body: JSON.stringify({ userId, plan }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'set plan failed');
      loadUsers();
    } catch (e) { alert(e.message || String(e)); }
  };

  const grant = async (userId) => {
    const amount = prompt('增加大文件额度：输入数量（正整数）', '10');
    if (!amount) return;
    try {
      const resp = await fetch('/api/admin/users/grantCredits', { method: 'POST', headers, body: JSON.stringify({ userId, amount: Number(amount) }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'grant failed');
      loadUsers();
    } catch (e) { alert(e.message || String(e)); }
  };

  const resetDaily = async (userId) => {
    if (!confirm('确认重置今日额度？')) return;
    try {
      const resp = await fetch('/api/admin/users/resetDaily', { method: 'POST', headers, body: JSON.stringify({ userId }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'reset failed');
      loadUsers();
    } catch (e) { alert(e.message || String(e)); }
  };

  if (!authUser) {
    return (
      <div style={{ maxWidth: 420, margin: '80px auto', background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: 24 }}>
        <h2 style={{ marginBottom: 12 }}>管理员登录</h2>
        <form onSubmit={doLogin}>
          <div style={{ marginBottom: 12 }}>
            <input className="input" placeholder="Admin Secret（x-admin-secret）" value={editingSecret} onChange={e => setEditingSecret(e.target.value)} />
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={saveSecret} className="btn btn-secondary" style={{ marginRight: 8 }}>保存 Secret</button>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <input className="input" placeholder="管理员账号" value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <input className="input" type="password" placeholder="管理员密码" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} />
          </div>
          <button className="btn btn-primary" type="submit">登录</button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px' }}>
      <h2>管理后台</h2>
      <div style={{ margin: '12px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={editingSecret} onChange={e => setEditingSecret(e.target.value)} placeholder="Admin Secret（x-admin-secret）" style={{ width: 360, padding: 8 }} />
        <button onClick={saveSecret}>保存</button>
        <button onClick={loadUsers}>刷新</button>
        <button onClick={logout}>退出登录</button>
        {loading && <span style={{ color: '#888' }}>加载中…</span>}
        {error && <span style={{ color: 'red' }}>{error}</span>}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>批量初始化/设套餐</div>
        <textarea
          value={bulkText}
          onChange={e => setBulkText(e.target.value)}
          placeholder="输入 Telegram ID，支持逗号/空格/换行分隔，例如：\n7506500905, 7650869672\n8141884827"
          style={{ width: '100%', minHeight: 90, padding: 10, border: '1px solid #e2e8f0', borderRadius: 6 }}
        />
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-primary" onClick={bulkInitAndSvip}>初始化并开通 SVIP</button>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Telegram ID</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>套餐</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>今日/日限</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>大文件额度</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>单文件上限</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.userId}>
              <td style={{ padding: 8 }}>{u.userId}</td>
              <td style={{ padding: 8 }}>
                <select value={u.plan} onChange={e => setPlan(u.userId, e.target.value)}>
                  <option value="free">FREE</option>
                  <option value="vip">VIP</option>
                  <option value="svip">SVIP</option>
                </select>
              </td>
              <td style={{ padding: 8 }}>{u.dailyUsed || 0} / {u.dailyLimit}</td>
              <td style={{ padding: 8 }}>{u.bigFileCredits || 0}</td>
              <td style={{ padding: 8 }}>{Math.round((u.maxFileBytes || 0) / 1024 / 1024)} MB</td>
              <td style={{ padding: 8 }}>
                <button onClick={() => grant(u.userId)} style={{ marginRight: 8 }}>加额度</button>
                <button onClick={() => resetDaily(u.userId)}>重置今日</button>
              </td>
            </tr>
          ))}
          {!users.length && !loading && (
            <tr><td colSpan="6" style={{ padding: 12, color: '#888' }}>暂无数据</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


