const raw = process.env.ROUTER_JWT_PRIVATE_JWK;

if (!raw) {
  console.error('Set ROUTER_JWT_PRIVATE_JWK to an ES256 private JWK first.');
  process.exit(1);
}

const jwk = JSON.parse(raw);
delete jwk.d;
console.log(JSON.stringify(jwk));
