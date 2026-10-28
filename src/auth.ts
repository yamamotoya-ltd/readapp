import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';

export type AccessVerifier = (request: Request, env: Env) => Promise<boolean>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(domain: string) {
  let jwks = jwksCache.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, jwks);
  }
  return jwks;
}

// Verifies the Cloudflare Access JWT. Fails closed: anything unexpected means "not allowed".
export const verifyAccess: AccessVerifier = async (request, env) => {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const domain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!domain || !aud) return false;
  try {
    await jwtVerify(token, jwksFor(domain), { issuer: `https://${domain}`, audience: aud });
    return true;
  } catch {
    return false;
  }
};
