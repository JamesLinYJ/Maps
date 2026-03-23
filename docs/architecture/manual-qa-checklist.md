# Manual QA Checklist

## Voice and transcript

- Confirm microphone permission states are visible and understandable.
- Confirm partial and final transcripts are shown in the UI.
- Confirm the user can interrupt speech playback before submitting a follow-up.

## Presentation flow

- Submit a focus request such as `带我看看浦东新区的重点区域` and confirm the map camera, highlight state, and narration remain consistent.
- Submit `切换到卫星图层，标出陆家嘴和张江科学城，并逐个讲解` and confirm the layer toggle and numbered callouts are visible.
- Submit `展示从机场到会展中心的大致路线，并说明沿线重点地标` and confirm the system asks a clarification question instead of guessing.

## Compliance

- Confirm attribution text and the domestic review number remain visible in `china_public` mode.
- Confirm foreign provider choices are disabled in `china_public` mode.
- Confirm non-public modes show the expected experimental warnings and provider notices.

## Responsive behavior

- Confirm the desktop layout keeps transcript, source cards, and compliance UI visible while the map remains readable.
- Confirm the mobile layout keeps the microphone button, transcript, and map stage usable without overlap.
