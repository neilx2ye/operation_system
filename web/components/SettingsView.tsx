'use client';

import { useEffect, useState } from 'react';

type View = {
  yuntu: { baseUrl: string; customerCode: string; apiSecretMask: string; channelCode: string; unitWeightKg: string };
  shopify: { shop: string; adminTokenMask: string; apiVersion: string };
  ready: { yuntu: boolean; shopify: boolean };
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
};
type TestResult = { ok: boolean; name?: string; domain?: string; missingScopes?: string[]; error?: string };

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
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

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
    });
  }

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(apply);
  }, []);

  if (!f || !view) return <div className="content">加载中...</div>;
  const set = (k: keyof Form) => (v: string) => setF({ ...f, [k]: v });

  async function save() {
    if (!f) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yuntu: { baseUrl: f.baseUrl, customerCode: f.customerCode, apiSecret: f.apiSecret, channelCode: f.channelCode, unitWeightKg: f.unitWeightKg },
          shopify: { shop: f.shop, adminToken: f.adminToken, apiVersion: f.apiVersion },
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

  return (
    <div className="content page-wide set-page">
      <h2 className="set-title">设置</h2>
      <div className="muted set-sub">接口配置保存在服务端(web/data/settings.json,已被 git 忽略),密钥不会回显到浏览器。设置页的值优先于环境变量。</div>

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
            <span className="muted">先保存再测试</span>
          </div>
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
      </div>

      <div className="set-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}
