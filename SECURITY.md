# Security Policy

## Supported Versions

Security fixes go into the latest minor release on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ubidk.mainframe-commander).
Older releases are not patched; update the extension to get a fix.

| Version | Supported          |
| ------- | ------------------ |
| 1.2.x   | :white_check_mark: |
| < 1.2   | :x:                |

## Reporting a Vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: on the
[Security tab](https://github.com/SMoRG75/mc/security) choose
**Report a vulnerability**. Only the maintainer can see the report.

Include what you can of:

- the mc version, VS Code version and operating system
- the profile type involved (`zosmf` or `rse`)
- the steps that show the problem, and what an attacker gains from it

Leave out real passwords, tokens, certificates and host names. A
`zowe.config.json` with the secure values removed is enough.

### What happens next

mc is maintained by one person, so the times below are targets, not promises:

- **Acknowledgement** within 7 days.
- **Assessment** within 14 days: whether the report is accepted, and why if it
  is not.
- **Updates** at least every 14 days while a fix is in progress.
- **Fix** in a patch release of the supported version, with the report credited
  in the [changelog](CHANGELOG.md) unless you would rather not be named.

Please keep the details private until a fixed release is on the Marketplace.

### Out of scope

mc connects through other people's code. Problems in these belong with their
own projects, though a note here is welcome if mc uses them unsafely:

- [Zowe](https://www.zowe.org/) SDKs and the Zowe credential manager
- IBM's RSE API and its plug-in for Zowe CLI
- z/OSMF and the z/OS host itself
