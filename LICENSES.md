# Licensing and attribution

This repository contains multiple licenses. SPDX headers on individual files remain authoritative.

| Files | Provenance | License |
| --- | --- | --- |
| `src/BitbankFeeSplitter.sol`, `src/BitbankLaunchLocker.sol`, tests and scripts | Bitbank contributors | MIT |
| `src/BitbankLaunchFactory.sol` | Bitbank adaptation of Pons Family V1 | MIT source header; includes linked GPL tick math |
| `src/vendor/pons-v1/*` except tick math | Pons Family, upstream snapshot 845bd546b37515621e47b08015ce4f9d374f6eca | MIT source headers |
| `src/vendor/pons-v1/libraries/PonsTickMath.sol` | Pons / Uniswap V3 TickMath lineage | GPL-2.0-or-later |
| `lib/openzeppelin-contracts/*` | OpenZeppelin contributors, as vendored upstream | MIT source headers |

See `LICENSES/MIT.txt` for the MIT text and `LICENSES/GPL-2.0.txt` for GPL version 2. The tick-math source explicitly permits later versions. All original source notices are retained. Distributions of the combined factory must account for its GPL dependency; the MIT notices on original components do not replace that dependency's license.

No upstream V2/V4/BUSL code is included. The inspected upstream snapshot has no repository-root LICENSE file; attribution is preserved from its README and source headers rather than inventing an upstream copyright notice.
