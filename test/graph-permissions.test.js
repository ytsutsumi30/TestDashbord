const assert = require("node:assert/strict");
const test = require("node:test");

const diagnostics = require("../scripts/verify-graph-permissions");

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

test("parseJwtRoles extracts and sorts application roles", () => {
  const token = fakeJwt({ roles: ["OnlineMeetingTranscript.Read.All", "Files.ReadWrite.All"] });
  assert.deepEqual(diagnostics.parseJwtRoles(token), [
    "Files.ReadWrite.All",
    "OnlineMeetingTranscript.Read.All"
  ]);
});

test("permissionHint explains common Graph authorization failures", () => {
  assert.match(
    diagnostics.permissionHint(403, "Authorization_RequestDenied", "Insufficient privileges"),
    /admin consent/
  );
  assert.match(
    diagnostics.permissionHint(401, "InvalidAuthenticationToken", "Unauthorized"),
    /tenant\/client IDs/
  );
  assert.match(
    diagnostics.permissionHint(404, "itemNotFound", "Resource not found"),
    /MS_USER_UPN/
  );
});

test("encodeGraphPath encodes path segments but preserves separators", () => {
  assert.equal(
    diagnostics.encodeGraphPath("Apps/Meeting Minutes/診断.txt"),
    "Apps/Meeting%20Minutes/%E8%A8%BA%E6%96%AD.txt"
  );
});
