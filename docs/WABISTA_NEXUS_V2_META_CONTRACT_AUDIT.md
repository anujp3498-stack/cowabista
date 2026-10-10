# Wabista Nexus V2 — Meta media + template-authoring contract audit

Gate: **Meta media/template-authoring contract verification**.
Result: **PARTIAL / REQUIRES META DEV ACCOUNT CHECK** (not passed; the gate stays OPEN).
Status reconciled on 2026-10-09, and again on 2026-10-10 (VIDEO header creation), with real Meta Graph API checks run by the project owner. The current status of every gate point is in **section 9**. Sections 2–7 keep the original 2026-10-05 findings, annotated where later evidence changed them. Section 8 records the 2026-10-09 Resumable Upload follow-up and fix.

- Date: 2026-10-05
- Branch `wabista-nexus-v2`. Product code tested at `221d8d9b656b67ad06f0bd1fd58ef7ada9154d27`, unchanged by this audit. The commit carrying this file adds only a test, a test script and documentation.
- Protected production `claude/wabista-nexus-tps-regression-lqp5ap` = `d22a8e43bf0d36d1565c011aed77486767fb8318`, untouched.
- Nothing was sent to Meta. There were no real templates, uploads or messages and no real token. Every request went to a local fake Graph API.

## 1. Sources

`developers.facebook.com` is blocked by this environment's egress policy, through both curl and the web fetcher, so the human-readable developer documentation could not be read. The audit therefore relies only on Meta-published, machine-readable or sample sources, fetched from `raw.githubusercontent.com` on 2026-10-05:

| Source (Meta-owned) | URL | sha256 |
|---|---|---|
| Official OpenAPI spec "Business Messaging – WhatsApp API", **v23.0** | https://raw.githubusercontent.com/facebook/openapi/main/business-messaging-api_v23.0.yaml | `5c1973265369944b7cdfa3fa690985713575249042e2b7edd46be3ef9bd9b09d` |
| Official Python Business SDK: `adobjects/application.py` (`/uploads` edge) | https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/application.py | `2f3b98392e4d064c7ab9a844b5b554f9d41fe12f448c0586da217bcef32e0c25` |
| Python SDK: `adobjects/whatsappbusinessaccount.py` (`message_templates`, status enum) | …/facebook_business/adobjects/whatsappbusinessaccount.py | `72328a51cb296bbf4cd941820dc7452b24d74bfd13e0ef137e971cf9e33e6674` |
| Python SDK: `apiconfig.py` (`API_VERSION: v26.0`) | …/facebook_business/apiconfig.py | `0dd4561d332606a38ac3276cbb9d9c6ccbd7fe915a119d9558123d83632b4afd` |
| Python SDK: `api.py` (Cursor paging) | …/facebook_business/api.py | `2f2e537354859758faba0d89a910b2212b478e0b2aaee771bb1c239abf4c2c72` |
| Official sample: Jasper's Market `template.sh` (Resumable Upload → `header_handle`) | https://raw.githubusercontent.com/fbsamples/whatsapp-business-jaspers-market/main/template.sh | `37c5926de68337310ef71564d07da0cc1983416d2facdf1fd97fd154fba6713d` |
| Official sample: Jasper's Market README (handle vs media id) | …/whatsapp-business-jaspers-market/main/README.md | `1f823ae34a1f41fa98ccb8f1ac0ed614a71b2eb9c2f416a0fbf4406ec8647c4b` |
| Official sample: `whatsapp-api-examples` education `messageHelper.js` | https://raw.githubusercontent.com/fbsamples/whatsapp-api-examples/main/template-for-education-js/messageHelper.js | `2f255d743d6c346e41f51d05ae9d02975168a4098d609768979620fdad82ab6e` |
| Official sample: `message-templates-js` controller | …/whatsapp-api-examples/main/message-templates-js/complete-app/controller/messageTemplates.js | `cacefd0a1e1c571cd49d5a1ef1dce540b2339c0780dbde76e4e437ca0b89ef99` |
| Official sample: `media-messages-js` validations | …/whatsapp-api-examples/main/media-messages-js/complete-app/helper/validations.js | `387db614d32facc1bb87bb8d1ade72e86d213ef54fd9406ca7ded36e178aecd3` |

Spec lines cited below refer to that v23.0 YAML. The spec is generated from Meta's request examples. It has examples and loose schemas: few `required` lists, few enums and no limits. Where the spec is silent, a point is classed as unverifiable, not as a match. No blog or BSP source was used.

## 2. Graph API version

- **Wabista** uses **v23.0** everywhere:
  - `whatsapp-manual-client.ts` `MANUAL_GRAPH_API_VERSION`;
  - `whatsapp-direct-sender.ts` `DIRECT_GRAPH_API_VERSION`;
  - the literal `/v23.0/…` paths in `whatsapp-provider.ts`.
- **Spec:** the official spec is v23.0, the same version.
- **Newer versions:** Meta's SDK is at v26.0, and its changelog lists v24 and v25.
- ~~**Unverifiable here:** whether v23.0 is still served on 2026-10-05.~~ **CONFIRMED (real Meta, 2026-10-09):** a real request addressed to `https://graph.facebook.com/v23.0/…` **succeeded**. Its response carried `Facebook-Api-Version: v25.0`, and the `paging.next` URL it returned also used `https://graph.facebook.com/v25.0/…`. So v23.0-addressed calls are currently **accepted**, and Meta **served the tested request as v25.0**.
- This does **not** prove that Wabista should change its hard-coded version now. A Graph-version migration remains a separate compatibility decision (section 9, open item 3). Wabista still does not read the `facebook-api-version` header.

## 3. Results by contract area

| Area | Wabista request (code) | Official contract | Result |
|---|---|---|---|
| Template create | `POST /v23.0/{waba external id}/message_templates`, JSON, `Authorization: Bearer`, body `{name, language, category, components}` (`template-authoring.ts` `buildTemplateCreatePayload`, `template-submission.ts`, `whatsapp-manual-client.ts` `createTemplate`) | spec 28243, 28464-28538 (JSON body, bearerAuth 262-266); reply `{id, status, category}` 28799-28833 | **MATCH** |
| BODY variables | `example.body_text: [[v1..vn]]` (array of arrays, in variable order) | spec 28649-28651, 28699-28703, 28747-28751 | **MATCH** |
| HEADER text variable | `{type: HEADER, format: TEXT, text, example: {header_text: [v]}}` | spec 28643-28648, 28738-28745 | **MATCH** |
| URL button variable | button-level `example: [value]` | spec 28706-28713 | **MATCH** |
| Quick reply / footer | `{type: QUICK_REPLY, text}`, `{type: FOOTER, text}` | spec 28752-28758, 28704-28705 | **MATCH** |
| Phone button | E.164 **with `+`**: validation refuses digits-only input; payload sends `"+16467043595"` | examples use digits only (`'16467043595'`, 28673, 28705); no pattern given. **Real Meta (2026-10-09):** approved templates carry `+`-prefixed `phone_number` values (`+919305678460`, `+917080901492`, status `APPROVED`) | 2026-10-05: MISMATCH (minor) / ambiguous. **Now RESOLVED:** Meta accepts `+`-prefixed values; no digits-only normalisation is needed (section 9) |
| Media header (image, document) | `{type: HEADER, format: IMAGE\|DOCUMENT, example: {header_handle: [h]}}`, where `h` is the Resumable Upload handle | spec 28657-28715; `template.sh` 26-57 | **MATCH** |
| Media header (video) | `format: VIDEO` with `header_handle` | no VIDEO creation example in the v23.0 spec or the samples. **Real Meta (2026-10-10, Graph v25.0):** a template created with `{type: HEADER, format: VIDEO, example: {header_handle: [<handle from a video/mp4 Resumable Upload>]}}` returned HTTP 200 `{id, status: PENDING, category: MARKETING}` | 2026-10-05: UNVERIFIABLE (material). **Now RESOLVED / CONFIRMED** (section 9, evidence 6) |
| Template media authoring: step 1 | `POST /v23.0/{WHATSAPP_APP_ID}/uploads?file_length&file_type&file_name`, Bearer header (token never in the query) | `py-application.py` `create_upload` (file_length, file_name, file_type); `template.sh:26` | **MATCH** |
| Template media authoring: step 2 | Was `POST /v23.0/{encodeURIComponent(session id)}`; **now** `POST /v23.0/{session id verbatim}` (`resumableUploadUrl`); `Authorization: OAuth`, `file_offset: 0`, raw bytes, reply `h` | `template.sh:31-34` and education sample use `Authorization: OAuth`, `file_offset: 0` and the reply `.h`, and put the session id **raw** in the path. Real Graph API test (v25.0, 2026-10-09): raw `upload:<opaque>?sig=<opaque>` → HTTP 200 `{h}`; whole id percent-encoded → HTTP 400, code 100, subcode 33 | Auth, offset, body and reply: **MATCH**. Session-id encoding: was a **CONFIRMED MISMATCH (material)**, now **FIXED** (see section 8) |
| Message media upload | `POST /v23.0/{provider phone id}/media`, multipart: `messaging_product=whatsapp`, `type=<mime>`, `file` (with filename and MIME); reply `{id}` stored as the WhatsApp media id | spec 12525-12608 (multipart `file` + `messaging_product`; reply `{id}`) | **MATCH**. The extra `type` field is used by Meta's sample, not listed in the spec: unverifiable, minor |
| Template send | `POST /v23.0/{provider phone id}/messages`, JSON, Bearer: `{messaging_product, recipient_type: individual, to, type: template, template: {name, language: {code}, components?}}` | spec 12622-13620; `LanguageObject` 1611-1626 | **MATCH**, except that `language.policy` is marked required in the schema but omitted by Wabista and by most official examples: ambiguous, minor |
| Send header media | `{type: header, parameters: [{type: image\|video\|document, <kind>: {id: <WhatsApp media id bound to the sending number>}}]}` | `MediaObject` 1859-1877 (`id` or `link`) | **MATCH** |
| Send body / URL button | `{type: body, parameters: [{type: text, text}]}`; `{type: button, sub_type: url, index: "0", parameters: [{type: text, text}]}` | spec 1640-1660, 12920-13010 | **MATCH** |
| Header `link` from a static/CSV mapping | any non-empty string up to 1024 chars sent as `{link: value}` | `MediaObject.link`: `format: url`, HTTP/HTTPS only | **MISMATCH (minor)**: not validated |
| CSV text parameters | unbounded | `TextParameter.text` maxLength 32768 (1753-1766) | **MISMATCH (minor)** |
| Template list/sync | `GET …/message_templates?fields=id,name,language,category,status,components&limit=100[&after]`; continues only when `paging.next` is non-empty **and** `cursors.after` is present; stops when `next` is absent, null or empty | spec 28243-28461 (listing response with `paging.cursors`); SDK `Cursor.load_next_page` (both `after` and the `next` key) | **MATCH** with the SDK. The accepted V2-04 rule is kept. **Real Meta (2026-10-09):** on a non-terminal page (`limit=1`), `paging.next` (a v25.0 URL) and `cursors.after` were both present; a terminal page had `cursors.before`/`after` and **no** `next`. Termination semantics: **CONFIRMED**. `limit=1`: **CONFIRMED**. Exact `limit=100`: **STILL OPEN** (not exercised; section 9). Pagination overall: **PARTIALLY CONFIRMED** |
| Template status | Meta statuses mapped (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DELETED, LIMIT_EXCEEDED, ARCHIVED); raw value kept as `providerStatus`; only Approved is sendable | SDK `status_enum` (`whatsappbusinessaccount.py` 941-952) | **MATCH** |
| Legacy connector page walk (`whatsapp-provider.ts` `pages()`, legacy phone-number listing only) | continues on `cursors.after` when `next` is absent; follows `next` by copying its path and query (origin dropped, sent through the connector proxy, so its version segment is kept); no page cap or repeat detection | SDK requires `next`. **Real Meta (2026-10-09, `message_templates` edge):** terminal pages keep `after` without `next`, and `next` URLs use v25.0 | **MISMATCH (minor)**: legacy path only, not fixed. The real evidence makes the extra request after the last page expected rather than theoretical. Continuation pages would be addressed as v25.0, because the path of `next`, including its version segment, is copied. Observed on the templates edge, not yet on `phone_numbers` |
| Errors | keeps `error.code`, redacted `message`, HTTP status | `GraphAPIError` also defines `error_subcode`, `fbtrace_id`, `is_transient`, `error_user_msg` (353-396) | **MISMATCH (minor, diagnostics)**: these fields are dropped. HTTP 429 / `is_transient` is treated as permanent in template sync and create |
| Security | token only in `Authorization` (Bearer; `OAuth` for upload step 2); never in query, body, plan, job, allocation, broker payload, API response or log | spec bearerAuth; samples | **MATCH** |

## 4. Identifier chain (what is sent to Meta at each stage)

1. **Template-authoring media.** The request bytes become a `template_media_uploads` row (internal id). Meta returns a session `id` (`upload:…`, stored as `provider_session_id`), then the handle `h` (stored as `provider_handle`). Only `h` is placed in `example.header_handle`. The row id and session id never are. The handle is never returned by the API.
2. **Campaign media.**
   - The upload becomes a `campaign_media_assets` row (internal id plus storage key).
   - At Plan, `POST /{provider phone id}/media` is called per (sending number, asset). Meta's `{id}` is stored as `campaign_media_provider_bindings.provider_media_id`.
   - The resolver attaches that id for the job's own sending number.
   - It is sent as `{<kind>: {id}}`. With no binding, the build throws; it never falls back to a link, an asset id or a handle.
3. **Templates.**
   - Meta's template id is stored as `templates.provider_template_id`.
   - Selection, plan, allocation and job use the internal `templates.id`.
   - The send uses the frozen `templates_snapshot` name and language for the job's `templateId`, never the internal id.
4. **Sender.** The plan and allocation hold the internal `phone_number_id` and route. The send URL uses `phone_numbers.provider_phone_id` of the job's frozen route.

Handles and media ids are distinct types in distinct columns, used on distinct endpoints. Meta's README states the same rule: "Template example handles are only used while creating templates. Runtime sends require media IDs uploaded for the phone number that sends the messages."

## 5. Fake Graph request-shape tests

New `artifacts/api-server/test/meta-contract.test.ts` (`pnpm run test:meta-contract`): 7 tests, all pass. It compares whole request bodies over the captured HTTP request; checking only for a 200 reply would not count:

- **Authoring 1–6:**
  1. text-only;
  2. text header, BODY variables and footer;
  3. image, 4. video and 5. document header, each through both Resumable Upload steps, with the exact bytes, `OAuth` and `file_offset: 0`, and `h` placed in `header_handle`;
  6. URL button with a variable, plus a phone button.
- **Sending 7–11 + `/media`:** the real chain (Message Studio save → plan → execute → production worker → direct transport) with 25 recipients over 5 templates (text-only, image, document, video, URL button).
  - The three multipart uploads are parsed: their fields, MIME types and bytes are checked.
  - Every `/messages` body is compared exactly with the job's frozen template, route and sender, and the media id bound to that sender.
  - Exactly one request per job.
- **Negative control:** flattening `body_text`, or sending the button `index` as a number, makes 6 of the 7 tests fail.

Existing Meta-facing suites re-run on a disposable Postgres, all passing (122 tests): template-drafts 12, template-submission 11, template-media 6, template-reconciliation 9, template-sync 22, provider-pagination 24, legacy-template-listing 2, manual-connection 10, campaign-media 3, send-fidelity 2, multi-template-send-fidelity 1, message-studio 7, template-mapping-v2 5, test-send 3, v2-plan-to-send 6.

## 6. Why the verdict is PARTIAL, not PASS

At the time of this audit, no **material** mismatch was confirmed, and every confirmed mismatch was minor (section 3). One material mismatch, the upload-session-id encoding, was later confirmed against the real Graph API and fixed (section 8). However, these material points cannot be settled from the official sources reachable here, and need a Meta **developer/test** WABA, never production:

1. ~~**Upload session id in the step-2 URL.**~~ **Resolved (2026-10-09).** A real Graph API v25.0 test confirmed that the id is `upload:<opaque>?sig=<opaque>`, that the raw form succeeds, and that percent-encoding the whole id fails (HTTP 400, code 100, subcode 33). Wabista now sends the id verbatim (section 8).
2. ~~**VIDEO header creation.** `format: VIDEO` with `header_handle` and `file_type=video/mp4` has no official example.~~ **RESOLVED / CONFIRMED (2026-10-10, Graph v25.0):** a real VIDEO-header template creation, with the handle from a real `video/mp4` Resumable Upload, returned HTTP 200 and Meta created the template (section 9, evidence 6).
3. ~~**Graph v23.0 support on 2026-10-05.**~~ **RESOLVED for acceptance (2026-10-09):** a v23.0-addressed request succeeded and was served as `Facebook-Api-Version: v25.0`. The version-migration and v25 compatibility question **stays open** (section 9, open item 3).
4. ~~**Template listing.**~~ **Mostly RESOLVED (2026-10-09):** `paging.next` with `cursors.after` on a non-terminal page, and `after` without `next` on a terminal page, are both **CONFIRMED**; `limit=1` is **CONFIRMED**. Exact `limit=100` has **not** been exercised and is **STILL OPEN** (section 9, open item 2).
5. **Handle lifetime and app binding.** Wabista uses a 30-day local TTL and one global `WHATSAPP_APP_ID` for every workspace token. **STILL OPEN.**
6. ~~**`phone_number` with `+`** in a PHONE_NUMBER button.~~ **RESOLVED (2026-10-09):** real approved templates carry `+`-prefixed `phone_number` values.

Observations outside request shape. Both concern accepted runtime and product behaviour; they are reported here and not changed:

- **Possible duplicate sends.** On `/messages`, an HTTP 5xx, a 2xx without `messages[0].id`, or a network error is treated as retryable, so the job is re-sent (`whatsapp-direct-sender.ts`, `classifyProviderError`). The spec does not say whether such a request was delivered. Only aborts/timeouts go through `delivery_unknown`. This is a decision for the runtime owners, not part of this gate. **Update: fixed** in the follow-up safety change. These outcomes are now `ProviderOutcomeUnknownError`, which settles as `delivery_unknown` and is never re-sent; only provable pre-connect failures stay retryable. See the implementation plan's "Safety fix: provider delivery ambiguity" note.
- **Unsupported template types.** Named-parameter templates (`{{name}}`) and structures the send builder cannot fill (LOCATION header, OTP/FLOW/catalog buttons, carousel) are not blocked at selection.

## 7. Proposed narrow corrective items (not implemented)

1. **Upload session id: DONE (2026-10-09).** The step-2 session id is used verbatim, validated rather than encoded (section 8).
2. **Header `link` values.** Validate static/CSV `header:media` link values as `http(s)` URLs (and PDF for documents) in `message-studio.ts` `validateMappings`.
3. **Error diagnostics.** Keep `error_subcode`, `fbtrace_id` and `is_transient` in internal error records. Treat HTTP 429 / `is_transient` as retryable in template sync and create (`whatsapp-provider.ts`, `template-submission.ts`, `whatsapp-template-sync.ts`).
4. ~~**Phone button.** Decide whether to accept and send digits-only `phone_number`, after the dev-account check.~~ **Withdrawn (2026-10-09):** real approved Meta templates confirm `+`-prefixed values are accepted. No digits-only normalisation is proposed just because some official examples omit `+`.
5. **CSV text length.** Bound CSV text parameters at 32768.

## 8. Follow-up: Resumable Upload session id (confirmed against the real Graph API, fixed)

**Real Meta evidence (run by the project owner, 2026-10-09, Graph API v25.0, one test file).**

- Step 1 returned an upload session id of the form `upload:<opaque>?sig=<opaque>`.
- Test A, raw id: `POST https://graph.facebook.com/v25.0/upload:<opaque>?sig=<opaque>` with `Authorization: OAuth <token>`, `file_offset: 0`, `Content-Type: application/octet-stream` and the raw bytes returned **HTTP 200** `{"h":"<handle>"}`. **PASS**.
- Test B, whole id encoded with `encodeURIComponent` (`…/upload%3A…%3Fsig%3D…`): returned **HTTP 400**, `GraphMethodException`, code 100, error_subcode 33 ("Unsupported post request … does not exist or does not support this operation"). Meta resolved the full decoded value `upload:<opaque>?sig=<opaque>` as the object id, so `?sig=` was no longer a query string. **FAIL**.

**Previous Wabista behaviour (confirmed bug).** `ManualMetaClient.uploadFile()` built `${baseUrl}/v23.0/${encodeURIComponent(sessionId)}`, which is the Test B form. Every media-header template upload would have failed at step 2 against the real API.

**Fix.** Changed only in `artifacts/api-server/src/services/whatsapp-manual-client.ts`.

- The new `resumableUploadUrl(baseUrl, sessionId)` builds `${baseUrl}/v23.0/${sessionId}` with Meta's id **verbatim**: `upload:<opaque>` stays in the path and `?sig=<opaque>` stays the query string. This is exactly Test A, and it is what Meta's samples do.
- The id is validated instead of encoded. All of these must hold, otherwise the call fails closed with `bad_upload_session` (non-retryable):
  - it starts with `upload:`;
  - it contains only printable ASCII, with no whitespace, `#` or `\`;
  - the URL built from it parses back to exactly itself (`new URL(raw).href === raw`: no dot segments, including `%2e%2e`, and no normalisation or re-encoding);
  - the URL is on the Graph origin.
- `createUploadSession()` applies the same check to Meta's step-1 reply, so an unusable id is refused before step 2 and nothing is stored. The user sees `provider_rejected` ("Meta refused the upload: … unusable upload session id").
- Unchanged: the step-1 request, `Authorization: OAuth` and `file_offset: 0` on step 2, the raw byte body, reading `h`, storage (`provider_session_id`, `provider_handle`), the handle never reaching API responses, and the Graph version Wabista calls (v23.0). The fix is at URL level. A v23.0-addressed upload has not itself been exercised. The real v23.0-addressed listing was served as v25.0, so it would very likely behave like the v25.0 test, but that is inference. It belongs to the version-compatibility item (section 9, open item 3).

**Tests.**

- New fixture `test/meta-upload-fixtures.ts` reproduces the observed Meta behaviour. Step 1 returns a realistic `upload:<base64 descriptor>?sig=<base64url>`. Step 2 resolves the decoded path segment as the object id, requires `sig` as a query parameter, and answers 400 / code 100 / subcode 33 otherwise.
- Both `template-media` and `meta-contract` use it, and both now assert the exact raw step-2 URL. `template-media` adds three tests (9 in total):
  - the raw id is accepted and the whole-id-encoded form is refused with 100/33;
  - `resumableUploadUrl` keeps base64 `+ / =` and the sig query verbatim, and refuses fragments, backslashes, whitespace, non-ASCII, dot segments (including `%2e%2e`), a missing `upload:` prefix and characters that would be re-encoded;
  - an unusable step-1 id fails closed, with no step-2 request and no stored row.
- **Negative control:** with the old `encodeURIComponent(sessionId)` line restored, every successful-upload test fails with the Meta 100/33 refusal: 3 in `template-media` and the image, video and document authoring tests in `meta-contract`.

**Gate status.** This resolves the most important material point of section 6. The gate stays **PARTIAL / OPEN**; section 9 has the current list of open points (narrowed on 2026-10-09).

## 9. Current status after real Meta checks (reconciled 2026-10-09; VIDEO update 2026-10-10)

The project owner ran these checks against the real Meta Graph API. Wabista did not: this environment still cannot reach Meta, and nothing was sent from here. Labels: **CONFIRMED** means observed directly; **RESOLVED** means a previously open gate item is closed by that evidence; **PARTIALLY CONFIRMED** means only part of the question was exercised; **STILL OPEN** means not yet verified.

### Real Meta evidence recorded

1. **Graph version behaviour.**
   - A real request addressed to `https://graph.facebook.com/v23.0/…` succeeded.
   - The response header was `Facebook-Api-Version: v25.0`, and the returned `paging.next` URL used `https://graph.facebook.com/v25.0/…`.
2. **Template listing, non-terminal page.**
   - `GET …/message_templates?fields=id,name,language,status,category&limit=1` returned one template row, with `paging.cursors.before`, `paging.cursors.after` and a non-empty `paging.next` (a v25.0 URL).
3. **Template listing, terminal page.**
   - A separate real template-list response ended with `paging.cursors.before` and `paging.cursors.after` and **no** `paging.next`.
4. **PHONE_NUMBER buttons.**
   - Real templates with status `APPROVED` were observed in Meta with `type: "PHONE_NUMBER"` and `phone_number` values `+919305678460` and `+917080901492`.
   - The observation is of approved templates as Meta lists them.
5. **Resumable Upload (v25.0).**
   - The raw `upload:<opaque>?sig=<opaque>` id **passed** (HTTP 200 `{h}`).
   - Percent-encoding the whole id **failed** (HTTP 400, code 100, subcode 33).
   - Section 8 has the details.
6. **VIDEO header template creation (2026-10-10, Graph API v25.0).**
   - The manual script set `API_VERSION="v25.0"` and used it for all three calls: `POST /v25.0/{APP_ID}/uploads`, `POST /v25.0/{UPLOAD_SESSION_ID}` and `POST /v25.0/{WABA_ID}/message_templates`.
   - Step 1 used `file_type=video/mp4`. Step 2 used `Authorization: OAuth`, `file_offset: 0` and the raw binary bytes. Meta returned a valid upload handle `h`.
   - That handle was used in a real template-creation request to an accessible, owned WABA, with the header `{"type": "HEADER", "format": "VIDEO", "example": {"header_handle": ["<real Meta handle>"]}}`.
   - Meta returned **HTTP 200** `{"id": "<template id>", "status": "PENDING", "category": "MARKETING"}`.
   - `PENDING` is Meta's review state, not a contract failure. Meta accepted the VIDEO header structure and created the template. The approval outcome is not part of this gate.
   - This confirms the VIDEO template-authoring path (`video/mp4` Resumable Upload, then a VIDEO-header template creation) **on Graph v25.0**. It does **not** show that every Wabista Graph operation is v25-compatible. Real WhatsApp message sends have still not been exercised against v25.0, so the version-migration decision stays open (open item 3).
   - Only sanitised evidence is recorded here: no token, upload-session signature, full handle or template id.

### Resolved / confirmed checks

| Check | Status | Evidence | What Wabista does |
|---|---|---|---|
| v23.0-addressed requests are accepted at all | **RESOLVED / CONFIRMED** | evidence 1 | Calls v23.0 (unchanged). |
| Which version Meta served the tested v23.0 request as | **CONFIRMED**: v25.0 | `Facebook-Api-Version: v25.0` | Does not read the header. Workspace listings rebuild continuation requests on the trusted `/v23.0/` path and never copy `next`. |
| `paging.next` together with `cursors.after` on a non-terminal page | **CONFIRMED** | evidence 2 | `collectValidatedPages` continues only when `next` is a non-empty string, using `after` on the original request path. |
| `after` without `next` on a terminal page | **CONFIRMED** | evidence 3 | `collectValidatedPages` (workspace and legacy template listings) and `ManualMetaClient.listPhoneNumbers` stop when `next` is absent, even when `after` is present. This **validates** the V2-04 rule: continue only when `paging.next` exists; `after` alone does not mean another page. |
| A positive `limit` is honoured | **CONFIRMED for `limit=1`** | evidence 2 | Listings send `limit=100` (see open item 2). |
| `+`-prefixed `phone_number` on PHONE_NUMBER buttons | **RESOLVED** | evidence 4 | Validation requires E.164 with `+`; the payload sends it with `+`. No digits-only normalisation is needed. This is no longer a production gate. |
| Resumable Upload session id used verbatim | **RESOLVED** (bug fixed in `5c80571` / `777cf54`) | evidence 5 | `resumableUploadUrl()` sends Meta's id verbatim, validated, never encoded. |
| VIDEO template-header creation (`format: VIDEO` with a Resumable Upload `header_handle` from `video/mp4`) | **RESOLVED / CONFIRMED** | evidence 6 | `buildTemplateCreatePayload` emits exactly `{type: HEADER, format: VIDEO, example: {header_handle: [h]}}`; `video/mp4` is an accepted template-media type (`TEMPLATE_MEDIA_LIMITS`). |
| Template-creation reply shape | **CONFIRMED** | evidence 6: `{id, status, category}` | `createTemplate` requires a string `id` and reads `status` and `category`. |

### Still open

1. **Handle lifetime and app binding.**
   - Wabista assumes a 30-day handle lifetime (local TTL).
   - It opens upload sessions on one global `WHATSAPP_APP_ID` with each workspace's own token. Neither assumption is verified.
   - Evidence 6 shows that a freshly uploaded handle is accepted for template creation. It says nothing about how long a handle stays valid, or about uploads opened on a different app than the one that issued the token.
2. **Exact `limit=100` behaviour.**
   - **STILL OPEN**: only `limit=1` was exercised; `limit=100` has not been exercised at all. Every template listing sends `limit=100`: the workspace `listTemplatesPaged` and the legacy `listTemplates`.
   - **Acceptance** of `limit=100` is unverified. If Meta refused it, every template listing would fail closed: nothing is applied or removed, but syncs would stop working. The workspace sync would report it as `provider_rejected`.
   - **Page size**, provided Meta accepts `limit=100`: correctness does not depend on Meta honouring exactly 100, because the walk follows cursors until `next` is absent. The remaining dependence is capacity. The 200-page cap (`MAX_PROVIDER_PAGES`) covers 20,000 templates at 100 per page. If Meta served fewer rows per page, a very large WABA would hit the cap sooner, and the sync then fails closed (`incomplete_listing`) rather than truncating.
   - **Priority:** low for page size. Acceptance is a one-request check (`GET …/message_templates?limit=100`).
3. **Graph-version migration / v25 compatibility.**
   - A **separate decision** from the fact that Meta currently accepts v23.0-addressed URLs and serves them as v25.0.
   - Because the tested call was served as v25.0, the behaviour Wabista experiences there is v25.0's, while this audit's static comparison used the v23.0 spec.
   - To decide: whether to move `MANUAL_GRAPH_API_VERSION` / `DIRECT_GRAPH_API_VERSION` and the literal `/v23.0/` paths. That needs a v25 compatibility review of the request shapes in section 3.
   - Not exercised against real Meta **at any version**, so not on v25.0 either: a WhatsApp message send.
   - Exercised on real Meta on **Graph v25.0** only, never as a v23.0-addressed call:
     - Resumable Upload (the image test and the `video/mp4` test);
     - a VIDEO-header template creation.
   - These v25.0 results cover only those paths. They do not establish v25 compatibility for the other operations in section 3.
   - **Not changed here**: `MANUAL_GRAPH_API_VERSION` and `DIRECT_GRAPH_API_VERSION` both stay `v23.0`.

### Unchanged minor items (code-level, not Meta-verification gates)

These are not changed by the real evidence and were not fixed in this reconciliation:
- header `link` values not validated as http(s);
- CSV text not bounded to 32768;
- Graph error diagnostics (`error_subcode`, `fbtrace_id`, `is_transient`) dropped, and 429 treated as permanent in template sync and create;
- the legacy connector `pages()` walk (phone-number listing only), which continues on `after` alone, copies the path and query of `next` (including its version segment) and has no page cap. The terminal-page evidence makes its extra request after the last page expected rather than theoretical.

