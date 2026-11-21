# Third-party source notices

The root `LICENSE` covers the LiveKit React starter and original code under MIT.
It does not replace the licenses of the following incorporated sources.

## LiveKit Agents UI

The copied and adapted `components/agents-ui/` and `hooks/agents-ui/` sources are
from [LiveKit components-js](https://github.com/livekit/components-js) and are
licensed under Apache-2.0, except for the two files identified below. Local copies
carry adaptation notices; imports, formatting, and call-interface integration can
differ from upstream. The source package declares Apache-2.0 in
[`packages/shadcn/package.json`](https://github.com/livekit/components-js/blob/87c7326ebf320efbccdcb29655d1ca8d7f1b79a9/packages/shadcn/package.json).
The upstream [license](third_party/livekit-components/LICENSE) and
[notice](third_party/livekit-components/NOTICE) are included without alteration.

- `components/agents-ui/react-shader-toy.tsx` retains its full upstream MIT header
  and the Morgan Villedieu (2018), Rysana, Inc. (2023), and LiveKit, Inc. (2026)
  copyright notices. The wave visualizer uses this shader helper.
- `components/agents-ui/agent-audio-visualizer-aura.tsx` is an independently written
  native SVG implementation under the root MIT license. The upstream optional aura
  shader under Polyform Non-Resale is not included.

The retained primary-source license and shader notices were checked against
[components-js revision 87c7326](https://github.com/livekit/components-js/tree/87c7326ebf320efbccdcb29655d1ca8d7f1b79a9).
This identifies the notice source; it does not claim all copied code is identical
to that revision. Provider logo attribution is in [SOURCE.md](public/providers/SOURCE.md).

## shadcn UI primitives

`components/ui/` (except the independently authored `sheet.tsx`) and
`lib/shadcn/utils.ts` include primitives copied or adapted from the LiveKit
Agents UI registry and shadcn UI. The LiveKit package license and notice above
apply to its incorporated contributions; the original shadcn sources retain
[their MIT license, Copyright (c) 2023 shadcn](third_party/shadcn-ui/LICENSE.md).
Their [primary source license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)
is included without alteration. Integration imports and formatting may differ.
