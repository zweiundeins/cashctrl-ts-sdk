---
name: Wrong or missing type
about: A generated type does not match what the API actually returns or accepts
labels: types
---

**Endpoint**
e.g. `/api/v1/order/read.json`

**What the SDK says**
```ts
// the generated type, or the error you got
```

**What the API actually returns/accepts**
```json
// a redacted sample response, or the docs excerpt for a param
```

**Which side is wrong?**
- [ ] Request parameter (scraped from the docs — likely a scraper bug)
- [ ] Response field (inferred from live probing — likely needs wider sampling)

Response types are inferred from one organisation's data, so fields that
organisation never populated are typed loosely. See the README's Caveats.
