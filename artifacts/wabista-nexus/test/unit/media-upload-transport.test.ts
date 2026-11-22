import assert from "node:assert/strict"
import { File } from "node:buffer"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

const path = new URL("../../src/lib/message-studio-model.ts", import.meta.url)
const sourceText = readFileSync(path, "utf8")

const ast = ts.createSourceFile(
  "message-studio-model.ts",
  sourceText,
  ts.ScriptTarget.Latest,
  true
)

const declaration = ast.statements.find(
  node =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "uploadCampaignMediaFile"
)

assert.ok(declaration, "Actual upload function must exist")

const compiled = ts.transpileModule(
  declaration.getText(ast).replace(/^export[ ]+/, ""),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None
    }
  }
).outputText

const names = [
  "PG618 - Bônus Diário 🇧🇷.png",
  "प्रचार चित्र.png",
  "活动图片 🐉.png",
  "Cashback 30% [VIP] & bônus.png"
]

const bytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 11, 22, 33, 44
])

for (const fileName of names) {
  test("Unicode upload preserves bytes and filename: " + fileName, async () => {
    let calls = 0

    const sandbox = {
      encodeURIComponent,
      Error,
      getUploadCampaignMediaUrl: (organizationId, campaignId) => {
        assert.equal(organizationId, 1)
        assert.equal(campaignId, 2)
        return "https://example.invalid/media"
      },
      fetch: async (url, init) => {
        calls++

        assert.equal(url, "https://example.invalid/media")

        const request = new Request(url, init)

        assert.equal(request.method, "POST")
        assert.equal(
          request.headers.get("x-file-name"),
          encodeURIComponent(fileName)
        )
        assert.equal(
          decodeURIComponent(request.headers.get("x-file-name")),
          fileName
        )
        assert.equal(
          request.headers.get("content-type"),
          "image/png"
        )
        assert.deepEqual(
          new Uint8Array(await request.arrayBuffer()),
          bytes
        )

        return new Response(
          JSON.stringify({ id: 1, fileName }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" }
          }
        )
      }
    }

    const upload = vm.runInNewContext(
      compiled + String.fromCharCode(10) + "uploadCampaignMediaFile",
      sandbox,
      { timeout: 1000 }
    )

    const file = new File([bytes], fileName, {
      type: "image/png"
    })

    const result = await upload(1, 2, file)

    assert.equal(calls, 1)
    assert.equal(result.fileName, fileName)
  })
}
