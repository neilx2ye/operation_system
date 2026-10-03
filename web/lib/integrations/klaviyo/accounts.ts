import { klaviyoFetch } from './client';
import { klaviyoConfig, type KlaviyoConfig } from './config';

// 账号核对。GET /api/accounts 是无副作用的只读调用，因此可以安全地当作「测试连接」。
// 注意：账号检查成功只代表私钥有效，不代表拥有 templates:write / lists:write 等写权限。

export type KlaviyoAccount = { id: string; label: string };

type AccountsResponse = {
  data?: {
    id: string;
    attributes?: {
      contact_information?: {
        organization_name?: string | null;
        default_sender_name?: string | null;
        default_sender_email?: string | null;
      };
      preferred_currency?: string | null;
      timezone?: string | null;
    };
  }[];
};

export async function getAccounts(cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<KlaviyoAccount[]> {
  const body = await klaviyoFetch<AccountsResponse>({ path: '/api/accounts' }, cfg);
  return (body?.data ?? []).map((a) => {
    const info = a.attributes?.contact_information;
    return {
      id: a.id,
      label: info?.organization_name || info?.default_sender_name || info?.default_sender_email || a.id,
    };
  });
}

export type ConnectionTest = {
  ok: boolean;
  account: KlaviyoAccount | null;
  accounts: number;
  detail: string;
  readable: string[];
  unverified: string[];
};

/** 只读探测：能证明读权限，不能证明写权限。写权限一律显示为「首次操作验证」。 */
export async function testConnection(cfg: KlaviyoConfig | null = klaviyoConfig()): Promise<ConnectionTest> {
  const accounts = await getAccounts(cfg);
  const account = accounts[0] ?? null;
  return {
    ok: accounts.length > 0,
    account,
    accounts: accounts.length,
    detail: account ? `已连接账号 ${account.label}` : '私钥有效，但该账号下没有可读账号信息',
    readable: ['accounts:read'],
    unverified: ['templates:write', 'profiles:write', 'lists:write', 'images:write'],
  };
}