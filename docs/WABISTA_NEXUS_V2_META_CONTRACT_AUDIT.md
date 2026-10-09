# Wabista Nexus V2 — Meta media + template-authoring contract audit

Gate: **Meta media/template-authoring contract verification**.
Result: **PARTIAL / REQUIRES META DEV ACCOUNT CHECK** (not passed; the gate stays OPEN).

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
- **Unverifiable here:** whether v23.0 is still served on 2026-10-05. Meta's version changelog is on the blocked site. One live call that reads the `facebook-api-version` response header would settle it; Wabista never reads that header.

## 3. Results by contract area

| Area | Wabista request (code) | Official contract | Result |
|---|---|---|---|
| Template create | `POST /v23.0/{waba external id}/message_templates`, JSON, `Authorization: Bearer`, body `{name, language, category, components}` (`template-authoring.ts` `buildTemplateCreatePayload`, `template-submission.ts`, `whatsapp-manual-client.ts` `createTemplate`) | spec 28243, 28464-28538 (JSON body, bearerAuth 262-266); reply `{id, status, category}` 28799-28833 | **MATCH** |
| BODY variables | `example.body_text: [[v1..vn]]` (array of arrays, in variable order) | spec 28649-28651, 28699-28703, 28747-28751 | **MATCH** |
| HEADER text variable | `{type: HEADER, format: TEXT, text, example: {header_text: [v]}}` | spec 28643-28648, 28738-28745 | **MATCH** |
| URL button variable | button-level `example: [value]` | spec 28706-28713 | **MATCH** |
| Quick reply / footer | `{type: QUICK_REPLY, text}`, `{type: FOOTER, text}` | spec 28752-28758, 28704-28705 | **MATCH** |
| Phone button | E.164 **with `+`**: validation refuses digits-only input; payload sends `"+16467043595"` | examples use digits only (`'16467043595'`, 28673, 28705); no pattern given | **MISMATCH (minor) / ambiguous** |
| Media header (image, document) | `{type: HEADER, format: IMAGE\|DOCUMENT, example: {header_handle: [h]}}`, where `h` is the Resumable Upload handle | spec 28657-28715; `template.sh` 26-57 | **MATCH** |
| Media header (video) | `format: VIDEO` with `header_handle` | no VIDEO creation example in the v23.0 spec or the samples | **UNVERIFIABLE (material)** |
| Template media authoring: step 1 | `POST /v23.0/{WHATSAPP_APP_ID}/uploads?file_length&file_type&file_name`, Bearer header (token never in the query) | `py-application.py` `create_upload` (file_length, file_name, file_type); `template.sh:26` | **MATCH** |
| Template media authoring: step 2 | Was `POST /v23.0/{encodeURIComponent(session id)}`; **now** `POST /v23.0/{session id verbatim}` (`resumableUploadUrl`); `Authorization: OAuth`, `file_offset: 0`, raw bytes, reply `h` | `template.sh:31-34` and education sample use `Authorization: OAuth`, `file_offset: 0` and the reply `.h`, and put the session id **raw** in the path. Real Graph API test (v25.0, 2026-10-09): raw `upload:<opaque>?sig=<opaque>` → HTTP 200 `{h}`; whole id percent-encoded → HTTP 400, code 100, subcode 33 | Auth, offset, body and reply: **MATCH**. Session-id encoding: was a **CONFIRMED MISMATCH (material)**, now **FIXED** (see section 8) |
| Message media upload | `POST /v23.0/{provider phone id}/media`, multipart: `messaging_product=whatsapp`, `type=<mime>`, `file` (with filename and MIME); reply `{id}` stored as the WhatsApp media id | spec 12525-12608 (multipart `file` + `messaging_product`; reply `{id}`) | **MATCH**. The extra `type` field is used by Meta's sample, not listed in the spec: unverifiable, minor |
| Template send | `POST /v23.0/{provider phone id}/messages`, JSON, Bearer: `{messaging_product, recipient_type: individual, to, type: template, template: {name, language: {code}, components?}}` | spec 12622-13620; `LanguageObject` 1611-1626 | **MATCH**, except that `language.policy` is marked required in the schema but omitted by Wabista and by most official examples: ambiguous, minor |
| Send header media | `{type: header, parameters: [{type: image\|video\|document, <kind>: {id: <WhatsApp media id bound to the sending number>}}]}` | `MediaObject` 1859-1877 (`id` or `link`) | **MATCH** |
| Send body / URL button | `{type: body, parameters: [{type: text, text}]}`; `{type: button, sub_type: url, index: "0", parameters: [{type: text, text}]}` | spec 1640-1660, 12920-13010 | **MATCH** |
| Header `link` from a static/CSV mapping | any non-empty string up to 1024 chars sent as `{link: value}` | `MediaObject.link`: `format: url`, HTTP/HTTPS only | **MISMATCH (minor)**: not validated |
| CSV text parameters | unbounded | `TextParameter.text` maxLength 32768 (1753-1766) | **MISMATCH (minor)** |
| Template list/sync | `GET …/message_templates?fields=id,name,language,category,status,components&limit=100[&after]`; continues only when `paging.next` is non-empty **and** `cursors.after` is present; stops when `next` is absent, null or empty | spec 28243-28461 (listing response with `paging.cursors`); SDK `Cursor.load_next_page` (both `after` and the `next` key) | **MATCH** with the SDK. The accepted V2-04 rule is kept. Whether this edge actually emits `next`, and whether `limit=100` is accepted: **unverifiable (dev-account read)** |
| Template status | Meta statuses mapped (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION, DELETED, LIMIT_EXCEEDED, ARCHIVED); raw value kept as `providerStatus`; only Approved is sendable | SDK `status_enum` (`whatsappbusinessaccount.py` 941-952) | **MATCH** |
| Legacy connector page walk (`whatsapp-provider.ts` `pages()`, phone listing) | continues on `cursors.after` when `next` is absent | SDK requires `next` | **MISMATCH (minor)**: legacy path only |
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
2. **VIDEO header creation.** `format: VIDEO` with `header_handle` and `file_type=video/mp4` has no official example.
3. **Graph v23.0 support on 2026-10-05.** Read the `facebook-api-version` header from any call.
4. **Template listing.** Whether `paging.next` and `cursors.after` are emitted on non-final pages, and whether `limit=100` is accepted. Check: one read-only `GET message_templates?limit=1`.
5. **Handle lifetime and app binding.** Wabista uses a 30-day local TTL and one global `WHATSAPP_APP_ID` for every workspace token.
6. **`phone_number` with `+`** in a PHONE_NUMBER button. One template creation would settle it.

Observations outside request shape. Both concern accepted runtime and product behaviour; they are reported here and not changed:

- **Possible duplicate sends.** On `/messages`, an HTTP 5xx, a 2xx without `messages[0].id`, or a network error is treated as retryable, so the job is re-sent (`whatsapp-direct-sender.ts`, `classifyProviderError`). The spec does not say whether such a request was delivered. Only aborts/timeouts go through `delivery_unknown`. This is a decision for the runtime owners, not part of this gate. **Update: fixed** in the follow-up safety change. These outcomes are now `ProviderOutcomeUnknownError`, which settles as `delivery_unknown` and is never re-sent; only provable pre-connect failures stay retryable. See the implementation plan's "Safety fix: provider delivery ambiguity" note.
- **Unsupported template types.** Named-parameter templates (`{{name}}`) and structures the send builder cannot fill (LOCATION header, OTP/FLOW/catalog buttons, carousel) are not blocked at selection.

## 7. Proposed narrow corrective items (not implemented)

1. **Upload session id: DONE (2026-10-09).** The step-2 session id is used verbatim, validated rather than encoded (section 8).
2. **Header `link` values.** Validate static/CSV `header:media` link values as `http(s)` URLs (and PDF for documents) in `message-studio.ts` `validateMappings`.
3. **Error diagnostics.** Keep `error_subcode`, `fbtrace_id` and `is_transient` in internal error records. Treat HTTP 429 / `is_transient` as retryable in template sync and create (`whatsapp-provider.ts`, `template-submission.ts`, `whatsapp-template-sync.ts`).
4. **Phone button.** Decide whether to accept and send digits-only `phone_number`, after the dev-account check.
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
- Unchanged: the step-1 request, `Authorization: OAuth` and `file_offset: 0` on step 2, the raw byte body, reading `h`, storage (`provider_session_id`, `provider_handle`), the handle never reaching API responses, and the Graph version Wabista calls (v23.0). The fix is at URL level. Running a real upload on v23.0 is still worth doing during the remaining dev-account checks.

**Tests.**

- New fixture `test/meta-upload-fixtures.ts` reproduces the observed Meta behaviour. Step 1 returns a realistic `upload:<base64 descriptor>?sig=<base64url>`. Step 2 resolves the decoded path segment as the object id, requires `sig` as a query parameter, and answers 400 / code 100 / subcode 33 otherwise.
- Both `template-media` and `meta-contract` use it, and both now assert the exact raw step-2 URL. `template-media` adds three tests (9 in total):
  - the raw id is accepted and the whole-id-encoded form is refused with 100/33;
  - `resumableUploadUrl` keeps base64 `+ / =` and the sig query verbatim, and refuses fragments, backslashes, whitespace, non-ASCII, dot segments (including `%2e%2e`), a missing `upload:` prefix and characters that would be re-encoded;
  - an unusable step-1 id fails closed, with no step-2 request and no stored row.
- **Negative control:** with the old `encodeURIComponent(sessionId)` line restored, every successful-upload test fails with the Meta 100/33 refusal: 3 in `template-media` and the image, video and document authoring tests in `meta-contract`.

**Gate status.** This resolves the most important material point of section 6. The gate itself stays **PARTIAL / OPEN** for the remaining points: VIDEO header creation, v23.0 support, `paging.next` / `limit=100`, handle lifetime and app binding, and `phone_number` with `+`.

