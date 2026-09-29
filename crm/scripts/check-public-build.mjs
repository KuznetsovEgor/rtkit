#!/usr/bin/env node
import { publicHttpsOrigin } from './public-origin.mjs';

const web = publicHttpsOrigin(process.env.WEB_ORIGIN, 'WEB_ORIGIN');
const api = publicHttpsOrigin(process.env.VITE_API_URL, 'VITE_API_URL');
const auth = publicHttpsOrigin(process.env.VITE_KEYCLOAK_URL, 'VITE_KEYCLOAK_URL');
const configuredAuth = publicHttpsOrigin(process.env.KEYCLOAK_PUBLIC_ORIGIN, 'KEYCLOAK_PUBLIC_ORIGIN');
if (auth !== configuredAuth) throw new Error('VITE_KEYCLOAK_URL must match KEYCLOAK_PUBLIC_ORIGIN.');
if (new Set([web, api, auth]).size !== 3) throw new Error('Web, API, and Keycloak need distinct HTTPS origins in this profile.');
console.log('Public frontend origins are explicit HTTPS URLs. This does not verify DNS, TLS, or deployment.');
