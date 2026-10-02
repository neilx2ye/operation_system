// Shopify Admin GraphQL: 按订单号查 fulfillment order,创建 fulfillment 并写入追踪号。
// 需要 Admin API scopes: read_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders

export type ShopifyConfig = { shop: string; token: string; version: string };

import { loadSettings, shopifyReady } from '@/lib/settings';

export function shopifyConfig(): ShopifyConfig | null {
  const s = loadSettings();
  if (!shopifyReady(s)) return null;
  return { shop: s.shopify.shop.replace(/^https?:\/\//, '').replace(/\/+$/, ''), token: s.shopify.adminToken, version: s.shopify.apiVersion || '2025-07' };
}

export async function testShopify(cfg: ShopifyConfig) {
  const d = await gql(cfg, `{ shop { name myshopifyDomain } app: currentAppInstallation { accessScopes { handle } } }`, {});
  return { name: d.shop.name as string, domain: d.shop.myshopifyDomain as string, scopes: (d.app?.accessScopes ?? []).map((x: any) => x.handle as string) };
}

async function gql(cfg: ShopifyConfig, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error('Shopify HTTP ' + res.status);
  if (json.errors?.length) throw new Error('Shopify GraphQL: ' + JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

const FIND = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name displayFulfillmentStatus
  fulfillmentOrders(first: 10) { nodes { id status } } } } }`;

const CREATE = `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) {
  fulfillment { id status trackingInfo { number company url } } userErrors { field message } } }`;

export async function pushTrackingToShopify(cfg: ShopifyConfig, orderName: string, trackingNumber: string, notifyCustomer: boolean) {
  const name = orderName.replace('#', '');
  const data = await gql(cfg, FIND, { q: 'name:' + name });
  const order = data.orders.nodes[0];
  if (!order) throw new Error('Shopify 找不到订单 #' + name);
  const open = order.fulfillmentOrders.nodes.filter((f: any) => f.status === 'OPEN' || f.status === 'IN_PROGRESS');
  if (!open.length) throw new Error('订单 #' + name + ' 没有可发货的 fulfillment order(可能已发货)');
  const out = await gql(cfg, CREATE, {
    f: {
      notifyCustomer,
      trackingInfo: { number: trackingNumber, company: 'YunExpress', url: 'https://www.yuntrack.com/parcelTracking?id=' + encodeURIComponent(trackingNumber) },
      lineItemsByFulfillmentOrder: open.map((f: any) => ({ fulfillmentOrderId: f.id })),
    },
  });
  const errs = out.fulfillmentCreate.userErrors;
  if (errs?.length) throw new Error('Shopify userErrors: ' + JSON.stringify(errs));
  return out.fulfillmentCreate.fulfillment as { id: string; status: string };
}
