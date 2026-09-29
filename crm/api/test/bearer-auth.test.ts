import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyAccessToken } from '../src/app.js';

test('CRM accepts only signed access tokens for its issuer, audience and client', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'local-test', alg: 'RS256', use: 'sig' }] });
  const sign = (claims: Record<string, unknown>) => new SignJWT({
    sub: 'kam-1', name: 'КАМ', realm_access: { roles: ['kam'] }, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'local-test' })
    .setIssuer('http://issuer.test/realms/lct')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const verify = async (claims: Record<string, unknown>) => verifyAccessToken(
    await sign(claims), keys, 'http://issuer.test/realms/lct', 'lct-web',
  );

  assert.deepEqual(await verify({ aud: ['lct-web', 'account'], azp: 'lct-web' }), {
    sub: 'kam-1', name: 'КАМ', email: undefined, roles: ['kam'],
  });
  await assert.rejects(verify({ azp: 'lct-web' }), 'missing audience');
  await assert.rejects(verify({ aud: 'another-service', azp: 'lct-web' }), 'wrong audience');
  await assert.rejects(verify({ aud: 'lct-web', azp: 'another-client' }), 'wrong authorized party');
  await assert.rejects(verifyAccessToken(
    await sign({ aud: 'lct-web', azp: 'lct-web' }), keys, 'http://another-issuer.test/realms/lct', 'lct-web',
  ), 'wrong issuer');
});
