# VeyraN

<p align="center"><img src="./resources/icon.png" alt="VeyraN icon" width="100" /></p>

VeyraN is a private Notesnook-derived client being prepared for an Apple and desktop rebrand. The [VeyraN branding plan](docs/veyran-branding.md) records the safe changes, preserved identifiers, public-name research, and remaining release work. The original Notesnook project and Streetwriters retain their attribution under [GPL-3.0-or-later](LICENSE); see [NOTICE](NOTICE.md).

## Upstream Notesnook README

The following project description and links are retained as upstream documentation, not VeyraN-owned services or support channels.

<h3 align="center">Notesnook: an end-to-end encrypted note taking alternative to Evernote.</h3>
<p align="center">
<a href="https://notesnook.com/">Website</a> | <a href="https://notesnook.com/about">About us</a> | <a href="https://notesnook.com/roadmap">Roadmap</a> | <a href="https://notesnook.com/downloads">Downloads</a> | <a href="https://twitter.com/@notesnook">Twitter</a> | <a href="https://discord.gg/5davZnhw3V">Discord</a>
</p>

## Overview

Notesnook is a free (as in speech) & open-source note-taking app focused on user privacy & ease of use. To ensure zero knowledge principles, Notesnook encrypts everything on your device using `XChaCha20-Poly1305` & `Argon2`.

Notesnook is our **proof** that privacy does _not_ (always) have to come at the cost of convenience. We aim to provide users peace of mind & 100% confidence that their notes are safe and secure. The decision to go fully open source is one of the most crucial steps towards that.

This repository contains all the code required to build & use the Notesnook web, desktop & mobile clients. If you are looking for a full feature list or screenshots, please check the [website](https://notesnook.com/).

## Developer guide

### Technologies & languages

Notesnook is built using the following technologies:

1. JavaScript/Typescript — this repo is in a hybrid state. A lot of the newer code is being written in Typescript & the old code is slowly being ported over.
2. React — the whole front-end across all platforms is built using React.
3. React Native — For mobile apps we are using React Native
4. Electron — For desktop app
5. NPM — listed here because we **don't** use Yarn or PNPM or XYZ across any of our projects.

> **Note: Each project in the monorepo contains its own architecture details which you can refer to.**

### Monorepo structure

| Name                       | Path                                               | Description                                                          |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `@notesnook/web`           | [/apps/web](/apps/web)                             | Web client                                                           |
| `@notesnook/desktop`       | [/apps/desktop](/apps/desktop)                     | Desktop client                                                       |
| `@notesnook/mobile`        | [/apps/mobile](/apps/mobile)                       | Android/iOS clients                                                  |
| `@notesnook/web-clipper`   | [/extensions/web-clipper](/extensions/web-clipper) | Web clipper                                                          |
| `@notesnook/core`          | [/packages/core](/packages/core)                   | Shared core between all platforms                                    |
| `@notesnook/crypto`        | [/packages/crypto](/packages/crypto)               | Cryptography library wrapper around libsodium                        |
| `@notesnook/clipper`       | [/packages/clipper](/packages/clipper)             | Web clipper core handling everything related to actual page clipping |
| `@notesnook/editor`        | [/packages/editor](/packages/editor)               | Notesnook editor + all extensions                                    |
| `@notesnook/editor-mobile` | [/packages/editor-mobile](/packages/editor-mobile) | A very thin wrapper around `@notesnook/editor` for mobile clients    |
| `@notesnook/logger`        | [/packages/logger](/packages/logger)               | Simple & pluggable logger                                            |
| `@notesnook/sodium`        | [/packages/sodium](/packages/sodium)               | Wrapper around libsodium to support Node.js & Browser                |
| `@notesnook/streamable-fs` | [/packages/streamable-fs](/packages/streamable-fs) | Streaming interface around an IndexedDB based file system            |
| `@notesnook/theme`         | [/packages/theme](/packages/theme)                 | The core theme used in web & desktop clients                         |

### Contributing guidelines

The inherited [contributing guidelines](/CONTRIBUTING.md) describe upstream Notesnook development. They are retained as an upstream reference and do not define VeyraN support or release channels.

### Open source attribution

VeyraN retains the upstream license and copyright notices. See [LICENSE](LICENSE) and [NOTICE](NOTICE.md) for the source attribution. Upstream Notesnook support channels serve the upstream product; they are not VeyraN support channels.
