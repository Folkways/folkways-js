# Security policy

## Report a vulnerability

If you find a security problem in this SDK or in Folkways, email **[support@folkways.io](mailto:support@folkways.io)**
with "Security" in the subject.

**Don't** open a public issue, pull request or discussion about it. Public reports put every app that uses
Folkways at risk until a fix is out.

Please include:

- what the problem is and what an attacker could do with it;
- the affected package and version (`Folkways.version`), and the entry point (`@folkways/realtime`,
  `@folkways/realtime/server` or a store);
- the steps or code to reproduce it, or a proof of concept;
- how we can reach you for follow-up questions.

## What happens next

1. We confirm that we received your report.
2. We investigate, and tell you whether we can reproduce the problem and how serious we think it is.
3. We fix it and release the fix, keeping you updated along the way.
4. We agree with you on when to disclose it, and credit you in the release notes if you'd like.

While we work on it, please keep the details private, and don't access or change data that isn't yours.

## Supported versions

Security fixes go into the latest release of `@folkways/realtime`. Before version 1.0, update to the latest
version to get them.

## If a key or token leaks

This isn't a vulnerability, but it needs quick action:

- **A private signing key or shared secret:** in the Folkways dashboard, add a new signing key, switch your
  backend to it and delete the old one. Deleting a key ends every connection that uses a token signed with it.
- **A publishable key:** these are public by design and can only read. If one is being misused, revoke it on the
  segment's **Publishable keys** tab and ship a new one.
- **A user's token:** tokens expire within 15 minutes.

See [How authentication works](https://docs.folkways.io/docs/js-sdk/authentication) for details.
