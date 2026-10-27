# Getting help and reporting issues

## Find an answer

1. **Read the documentation** at [docs.folkways.io](https://docs.folkways.io). Most connection and permission
   problems are covered in [Errors and troubleshooting](https://docs.folkways.io/docs/js-sdk/errors).
2. **Search the existing issues** on [GitHub](https://github.com/Folkways/folkways-js/issues), open and closed.
   If someone has the same problem, add a 👍 or the details of your case to that issue instead of opening a new one.

## Report a bug

[Open a bug report](https://github.com/Folkways/folkways-js/issues/new/choose). A good report lets us reproduce the
problem quickly. Include:

- **What you did:** the smallest piece of code that shows the problem.
- **What you expected** to happen, and **what happened** instead.
- **The error:** its `codeName` and `message`, e.g. `Forbidden: not allowed (topic chat/lobby)`.
- **Versions:** the SDK version (`Folkways.version`), your runtime and its version (browser, Node.js, React Native,
  Deno or Bun), and your operating system.
- **The transport** in use, from `client.session?.transport` (`websocket` or `http`).
- **Logs**, if you can. Turn them on with `logger: consoleLogger('debug')` (import `consoleLogger` from
  `@folkways/realtime`). The SDK never logs tokens, but check for personal data before you paste.

### Never include

Issues are public. Never post:

- tokens, private signing keys or shared secrets;
- personal data of your users.

If you posted a secret by mistake, delete it from the issue and replace it in the Folkways dashboard: add a new
signing key and delete the old one, or revoke the publishable key. Editing the issue is not enough, because its
history stays visible.

## Suggest a feature

[Open a feature request](https://github.com/Folkways/folkways-js/issues/new/choose). Describe the problem you want
to solve before the solution you have in mind: there may be a way to do it today, or a design that fits more apps.

## Account, billing and dashboard questions

These aren't SDK issues. Email [support@folkways.io](mailto:support@folkways.io).

## Security vulnerabilities

Don't open an issue. Follow the [security policy](SECURITY.md) and email
[support@folkways.io](mailto:support@folkways.io).
