// The Job Signal extension's fixed identity. Chrome derives an unpacked extension's ID from the
// manifest's key, so the ID is the same on every install, and the board can check its origin.
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr6BOniy90kWmH2goXNsOCl4XAqnj7Azf59WN0zJhPFnFkLU+Tj0VaiouU0vhD0v0p2m1xdhsBhDECzjWCFyw6PY0nRu4J0LxmW2NZ43iWOaY2NNYMy2bhN3AuHyGIFEYnzfiON/hfVk3FMYKHZG2zcvfkqAVzXP0M4l07I2VNnYjJVwppyBDlM1z0IhozxWo9OUaqaCLTdcsu7ED7kN+omuUF/c13T7VFXZUBD0sGo0r3vLMj0AiObUOxmrcbOMyCG+4SmNlKW2szBKyYNBdKKb0SP/dlvVQPX9NjdBAHAW9kHqJdtQ0WRepwkOGxGYe/IfRrLCRQlpo5a4l5TEKRwIDAQAB";
export const EXTENSION_ID = "jehollohnciokailnjhcjngdkfpedldb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
