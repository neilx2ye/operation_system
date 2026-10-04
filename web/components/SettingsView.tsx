'use client';

import { useEffect, useRef, useState } from 'react';
import { useHotReload } from '@/lib/useHotReload';

type KlaviyoAccess = {
  operatorVerified: boolean;
  via: string | null;
  subject: string | null;
  note: string;
  localOperatorAllowed: boolean;
  trustedProxyConfigured: boolean;
  tokenConfigured: boolean;
  originsAllowlisted: number;
};
type Klaviyo = {
  accountId: string | null;
  accountLabel: string;
  storeKey: string;
  apiRevision: string;
  defaultListId: string | null;
  defaultListName: string;
  writesEnabled: boolean;
  lastCheck: { ok: boolean; detail: string } | null;
  lastCheckedAt: string | null;
  configured: boolean;
  keyMask: string;
  keySource: string;
  writesEnabledByEnv: boolean;
  writesReady: boolean;
  access: KlaviyoAccess;
};
type View = {
  yuntu: { baseUrl: string; customerCode: string; apiSecretMask: string; channelCode: string; unitWeightKg: string };
  shopify: { shop: string; adminTokenMask: string; apiVersion: string };
  klaviyo: Klaviyo;
  ready: { yuntu: boolean; shopify: boolean; klaviyo: boolean };
};
type Form = {
  baseUrl: string;
  customerCode: string;
  apiSecret: string;
  channelCode: string;
  unitWeightKg: string;
  shop: string;
  adminToken: string;
  apiVersion: string;
  accountLabel: string;
  storeKey: string;
  apiRevision: string;
  defaultListId: string;
  defaultListName: string;
  writesEnabled: boolean;
};
type StringKey = { [K in keyof Form]: Form[K] extends string ? K : never }[keyof Form];
type TestResult = { ok: boolean; name?: string; domain?: string; missingScopes?: string[]; error?: string };
type KlaviyoTestResult =
  | { ok: true; account: { id: string; label: string } | null; accounts: number; detail: string; readable: string[]; unverified: string[] }
  | { ok: false; error: string; authFailed: boolean };
type ShopifySyncStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  step: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  counts: Record<string, number> | null;
  warnings: string[];
};

type KlaviyoTestResponse = {
  ok?: boolean;
  account?: { id: string; label: string } | null;
  accounts?: number;
  detail?: string;
  readable?: string[];
  unverified?: string[];
  error?: string;
};

function Field(props: { label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean; mask?: string }) {
  return (
    <label className="set-field">
      <span className="set-label">{props.label}</span>
      <input
        type={props.secret ? 'password' : 'text'}
        autoComplete="off"
        value={props.value}
        placeholder={props.secret && props.mask ? '已保存 ' + props.mask + '(留空则不修改)' : props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="set-hint">{props.hint}</span>}
    </label>
  );
}

export function SettingsView() {
  const [view, setView] = useState<View | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [kTesting, setKTesting] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [kTest, setKTest] = useState<KlaviyoTestResult | null>(null);
  const [hl, setHl] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sync, setSync] = useState<ShopifySyncStatus | null>(null);
  const hlDone = useRef(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { version } = useHotReload();

  function apply(v: View) {
    setView(v);
    setF({
      baseUrl: v.yuntu.baseUrl,
      customerCode: v.yuntu.customerCode,
      apiSecret: '',
      channelCode: v.yuntu.channelCode,
      unitWeightKg: v.yuntu.unitWeightKg,
      shop: v.shopify.shop,
      adminToken: '',
      apiVersion: v.shopify.apiVersion,
      accountLabel: v.klaviyo.accountLabel,
      storeKey: v.klaviyo.storeKey,
      apiRevision: v.klaviyo.apiRevision,
      defaultListId: v.klaviyo.defaultListId ?? '',
      defaultListName: v.klaviyo.defaultListName,
      writesEnabled: v.klaviyo.writesEnabled,
    });
  }

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(apply);
  }, [version]);

  useEffect(() => {
    loadSync();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // 深链 ?integration=klaviyo 或 #klaviyo:滚动到卡片并高亮;只读 window.location,不写入任何持久状态
  useEffect(() => {
    if (!view || hlDone.current) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get('integration') !== 'klaviyo' && window.location.hash !== '#klaviyo') return;
    hlDone.current = true;
    setHl(true);
    document.getElementById('klaviyo')?.scrollIntoView({ block: 'start' });
  }, [view]);

  if (!f || !view) return <div className="content">加载中...</div>;
  const set = (k: StringKey) => (v: string) => {
    const next: Form = { ...f };
    next[k] = v;
    setF(next);
  };

  async function save() {
    if (!f || !view) return;
    const rev = f.apiRevision.trim();
    if (rev && !/^\d{4}-\d{2}-\d{2}$/.test(rev)) {
      setNotice({ ok: false, text: 'API revision 需要形如 2026-07-15' });
      return;
    }
    setSaving(true);
    setNotice(null);
    const kv = view.klaviyo;
    const patch: Record<string, string | boolean> = {};
    if (f.accountLabel !== kv.accountLabel) patch.accountLabel = f.accountLabel;
    if (f.storeKey !== kv.storeKey) patch.storeKey = f.storeKey;
    if (rev !== kv.apiRevision) patch.apiRevision = rev;
    if (f.defaultListId !== (kv.defaultListId ?? '')) patch.defaultListId = f.defaultListId;
    if (f.defaultListName !== kv.defaultListName) patch.defaultListName = f.defaultListName;
    if (f.writesEnabled !== kv.writesEnabled) patch.writesEnabled = f.writesEnabled;
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yuntu: { baseUrl: f.baseUrl, customerCode: f.customerCode, apiSecret: f.apiSecret, channelCode: f.channelCode, unitWeightKg: f.unitWeightKg },
          shopify: { shop: f.shop, adminToken: f.adminToken, apiVersion: f.apiVersion },
          ...(Object.keys(patch).length ? { klaviyo: patch } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) setNotice({ ok: false, text: d.error || '保存失败' });
      else {
        apply(d);
        setNotice({ ok: true, text: '已保存' });
      }
    } catch (e: any) {
      setNotice({ ok: false, text: e.message || '网络错误' });
    } finally {
      setSaving(false);
    }
  }

  async function loadSync(): Promise<ShopifySyncStatus | null> {
    try {
      const r = await fetch('/api/shopify/sync');
      if (!r.ok) return null;
      const d: ShopifySyncStatus = await r.json();
      setSync(d);
      return d;
    } catch {
      return null;
    }
  }

  /** 轮询同步状态；完成后提示结果。数据写入数据库会自动广播，其它页面随之刷新。 */
  function pollSync() {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      const d = await loadSync();
      if (d && d.state === 'running') {
        pollSync();
        return;
      }
      setSyncing(false);
      if (!d) return;
      if (d.state === 'done') setNotice({ ok: true, text: 'Shopify 数据同步完成，页面已自动刷新' });
      else if (d.state === 'error') setNotice({ ok: false, text: '同步失败：' + (d.error || '未知错误') });
    }, 2500);
  }

  async function startShopifySync() {
    setNotice(null);
    setSyncing(true);
    try {
      const r = await fetch('/api/shopify/sync', { method: 'POST' });
      const d = await r.json().catch(() => null);
      if (d?.status) setSync(d.status as ShopifySyncStatus);
      // 409 表示已在运行，继续轮询即可；其他非 2xx 直接提示
      if (!r.ok && r.status !== 409) {
        setNotice({ ok: false, text: d?.message || d?.error || '无法开始同步(HTTP ' + r.status + ')' });
        setSyncing(false);
        return;
      }
      pollSync();
    } catch (e: any) {
      setNotice({ ok: false, text: e.message || '网络错误' });
      setSyncing(false);
    }
  }

  async function testShopify() {
    setTesting(true);
    setTest(null);
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'shopify' }) });
      setTest(await r.json());
    } catch (e: any) {
      setTest({ ok: false, error: e.message || '网络错误' });
    } finally {
      setTesting(false);
    }
  }

  // 测试会由服务端写入 lastCheck/lastCheckedAt;这里只回读这两项,不用服务端视图覆盖表单里未保存的编辑
  async function syncLastCheck() {
    try {
      const r = await fetch('/api/settings');
      if (!r.ok) return;
      const d: View = await r.json();
      setView((prev) => (prev ? { ...prev, klaviyo: { ...prev.klaviyo, lastCheck: d.klaviyo.lastCheck, lastCheckedAt: d.klaviyo.lastCheckedAt } } : prev));
    } catch {
      // 只影响「最近检查」的展示,失败不改变测试结果本身
    }
  }

  async function testKlaviyo() {
    setKTesting(true);
    setKTest(null);
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'klaviyo' }) });
      const d: KlaviyoTestResponse | null = await r.json().catch(() => null);
      if (r.ok && d?.ok === true) {
        setKTest({
          ok: true,
          account: d.account ?? null,
          accounts: typeof d.accounts === 'number' ? d.accounts : 0,
          detail: typeof d.detail === 'string' ? d.detail : '',
          readable: Array.isArray(d.readable) ? d.readable : [],
          unverified: Array.isArray(d.unverified) ? d.unverified : [],
        });
      } else {
        setKTest({ ok: false, error: (d && d.error) || '测试失败(HTTP ' + r.status + ')', authFailed: r.status === 401 || r.status === 403 });
      }
      await syncLastCheck();
    } catch (e: any) {
      setKTest({ ok: false, error: e.message || '网络错误', authFailed: false });
    } finally {
      setKTesting(false);
    }
  }

  const kv = view.klaviyo;
  const accessLine = kv.access.operatorVerified
    ? '已验证(' + (kv.access.via ?? '未知来源') + (kv.access.subject ? ':' + kv.access.subject : '') + ')。' + kv.access.note
    : '未验证。' + kv.access.note;

  return (
    <div className="content page-wide set-page">
      <h2 className="set-title">设置</h2>
      <div className="muted set-sub">接口配置保存在服务端数据库(ops_settings 表),密钥不会回显到浏览器。设置页的值优先于环境变量。</div>

      {notice && <div className={'notice ' + (notice.ok ? 'ok' : 'err')}>{notice.text}</div>}

      <div className="grid2">
        <section className="panel set-card">
          <div className="set-head">
            <b>云途物流 (YunExpress)</b>
            <span className={'tag ' + (view.ready.yuntu ? 'green' : 'amber')}>{view.ready.yuntu ? '已配置' : '未配置'}</span>
          </div>
          <Field label="接口域名" value={f.baseUrl} onChange={set('baseUrl')} placeholder="https://...(由云途业务员/官方文档提供)" hint="不要带结尾斜杠和 /api 路径" />
          <Field label="客户编号" value={f.customerCode} onChange={set('customerCode')} />
          <Field label="ApiSecret" value={f.apiSecret} onChange={set('apiSecret')} secret mask={view.yuntu.apiSecretMask} />
          <Field label="渠道服务代码" value={f.channelCode} onChange={set('channelCode')} hint="ShippingMethodCode,必须与云途分配给你的渠道一致" />
          <Field label="默认单件重量 (kg)" value={f.unitWeightKg} onChange={set('unitWeightKg')} hint="商品暂无重量数据时用于估算包裹重量" />
          <div className="set-note muted">云途暂无官方确认的无副作用接口,因此不提供测试连接;请用一张测试订单验证。</div>
        </section>

        <section className="panel set-card">
          <div className="set-head">
            <b>Shopify</b>
            <span className={'tag ' + (view.ready.shopify ? 'green' : 'amber')}>{view.ready.shopify ? '已配置' : '未配置'}</span>
          </div>
          <Field label="店铺域名" value={f.shop} onChange={set('shop')} placeholder="your-store.myshopify.com" />
          <Field label="Admin API Token" value={f.adminToken} onChange={set('adminToken')} secret mask={view.shopify.adminTokenMask} hint="需要 read_orders、read/write_merchant_managed_fulfillment_orders 权限" />
          <Field label="API 版本" value={f.apiVersion} onChange={set('apiVersion')} placeholder="2025-07" />
          <div className="set-test">
            <button disabled={testing || !view.ready.shopify} onClick={testShopify}>
              {testing ? '测试中...' : '测试连接'}
            </button>
            <button disabled={syncing || !view.ready.shopify} onClick={startShopifySync}>
              {syncing ? '同步中...' : '同步 Shopify 数据'}
            </button>
            <span className="muted">先保存再测试 / 同步</span>
          </div>
          {sync && sync.state !== 'idle' && (
            <div className={'notice ' + (sync.state === 'error' ? 'err' : sync.state === 'done' ? 'ok' : '')}>
              {sync.state === 'running' && ('同步中：' + (sync.step || '准备中...'))}
              {sync.state === 'done' && '同步完成'}
              {sync.state === 'error' && ('同步失败：' + (sync.error || '未知错误'))}
              {sync.counts && (
                <div>
                  商品 {sync.counts.products ?? 0} · 客户 {sync.counts.customers ?? 0} · 订单 {sync.counts.orders ?? 0} · 弃购 {sync.counts.abandons ?? 0}
                </div>
              )}
              {sync.warnings && sync.warnings.length > 0 && <div>提示：{sync.warnings.join('；')}</div>}
              {sync.finishedAt && <div className="muted">完成于 {sync.finishedAt.slice(0, 16).replace('T', ' ')}</div>}
            </div>
          )}
          {test && (
            <div className={'notice ' + (test.ok && !test.missingScopes?.length ? 'ok' : 'err')}>
              {test.ok ? (
                <>
                  已连接:{test.name}({test.domain})
                  {test.missingScopes && test.missingScopes.length > 0 && <div>缺少权限:{test.missingScopes.join(', ')}</div>}
                </>
              ) : (
                test.error
              )}
            </div>
          )}
        </section>

        <section className={'panel set-card' + (hl ? ' hl' : '')} id="klaviyo">
          <div className="set-head">
            <b>Klaviyo（EDM 邮件）</b>
            <span className={'tag ' + (kv.configured ? 'green' : 'amber')}>{kv.configured ? '已配置' : '未配置'}</span>
          </div>

          <div className="set-field">
            <span className="set-label">私钥来源</span>
            <span>{kv.keySource}{kv.keyMask ? '(' + kv.keyMask + ')' : '(未配置)'}</span>
            <span className="set-hint">私钥只从服务端环境变量 KLAVIYO_PRIVATE_API_KEY 读取,设置页没有对应的输入框,也不会把私钥回显或保存到浏览器。</span>
          </div>

          <Field label="账号标签" value={f.accountLabel} onChange={set('accountLabel')} placeholder="例如:主账号/测试账号" hint="仅用于本地区分账号,测试连接成功后服务端会写入远端返回的账号名" />
          <Field label="店铺绑定" value={f.storeKey} onChange={set('storeKey')} placeholder="例如:your-store.myshopify.com" hint="标记该 Klaviyo 账号对应的店铺,仅本地记录,不参与 Klaviyo 请求" />
          <Field label="API revision" value={f.apiRevision} onChange={set('apiRevision')} placeholder="2026-07-15" hint="显式固定 Klaviyo 请求 revision,不跟随远端默认值;需形如 YYYY-MM-DD,留空则回退到服务端默认 revision" />
          <Field label="默认目标名单 ID" value={f.defaultListId} onChange={set('defaultListId')} placeholder="如 Rxxxxx" hint="名单同步的默认目标;留空表示未指定" />
          <Field label="默认目标名单名称" value={f.defaultListName} onChange={set('defaultListName')} placeholder="用于人工核对名单" />

          <label className="set-field">
            <span className="set-label">允许真实写入</span>
            <span className="set-test">
              <input type="checkbox" checked={f.writesEnabled} onChange={(e) => setF({ ...f, writesEnabled: e.target.checked })} />
              <span className="muted">本页局部开关,默认关闭;关闭时模板设计与预览不受影响</span>
            </span>
          </label>

          <div className="set-test">
            <button disabled={kTesting || !kv.configured} onClick={testKlaviyo}>
              {kTesting ? '测试中...' : '测试连接'}
            </button>
            <span className="muted">{kv.configured ? '调用 Klaviyo GET /api/accounts 只读核对,先保存再测试' : '未配置 KLAVIYO_PRIVATE_API_KEY 环境变量,无法测试连接'}</span>
          </div>

          {kTest && (kTest.ok ? (
            <div className="notice ok">
              已连接：{kTest.account ? kTest.account.label + '（' + kTest.account.id + '）' : kTest.detail || '私钥有效,但未读取到账号信息'}
              <div className="set-hint">已确认读权限:{kTest.readable.join('、') || '无'}</div>
              <div className="set-hint">待首次操作验证:{kTest.unverified.join('、') || '无'} —— 账号检查通过只证明私钥有效,不能证明 templates:write 等写权限已配置。</div>
              {kTest.accounts > 1 && <div className="set-hint">该私钥可读 {kTest.accounts} 个账号,此处展示第一个。</div>}
            </div>
          ) : (
            <div className="notice err">
              {kTest.error}
              {kTest.authFailed && <div className="set-hint">操作员身份未验证:真实 Klaviyo 写入只允许本机、已配置的可信上游网关或显式令牌。</div>}
            </div>
          ))}

          {kv.lastCheckedAt && (
            <div className="set-note muted">
              最近检查:{new Date(kv.lastCheckedAt).toLocaleString()}
              {kv.lastCheck ? '(' + (kv.lastCheck.ok ? '成功' : '失败') + ':' + kv.lastCheck.detail + ')' : ''}
            </div>
          )}

          <div className="set-head">
            <b>真实写入闸门</b>
            <span className={'tag ' + (kv.writesReady ? 'green' : 'amber')}>{kv.writesReady ? '已就绪' : '未就绪'}</span>
          </div>
          <div className="set-field">
            <span className="set-hint">私钥:{kv.configured ? '已配置' : '未配置 KLAVIYO_PRIVATE_API_KEY'}</span>
            <span className="set-hint">环境开关:{kv.writesEnabledByEnv ? 'KLAVIYO_ENABLE_WRITES 已设为 true' : 'KLAVIYO_ENABLE_WRITES 不是 true'}</span>
            <span className="set-hint">本地开关:{kv.writesEnabled ? '已打开' : '未打开'}</span>
            <span className="set-hint">操作员身份:{accessLine}</span>
          </div>
          {kv.writesReady ? (
            <div className="set-note muted">真实写入已就绪,但每次写操作仍需确认影响范围:不调用发送 API 也不能保证远端绝不发信。</div>
          ) : (
            <div className="set-note muted">真实写入关闭不影响模板设计与预览,只是真实发布、图片上传和名单同步会一并被服务端拦截,前端禁用按钮不等于授权。</div>
          )}
        </section>
      </div>

      <div className="set-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}