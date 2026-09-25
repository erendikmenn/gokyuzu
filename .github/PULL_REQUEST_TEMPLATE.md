<!-- Thanks for contributing! English or Turkish is fine. See CONTRIBUTING.md. -->

## What and why

<!-- What does this change, and why? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands you ran, devices and browsers you tried (phone, tablet, desktop; Chrome, Safari, Firefox). -->

## Screenshots or video

<!-- Required for visual changes: before and after, the same camera and time of day if you can.
     Leave out personal data. -->

## Performance

<!-- Required for changes to rendering, streaming, assets or per-frame code: the numbers before and after, and the
     command that produced them (tools/perf/…). Write "no runtime impact" otherwise. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).
- [ ] All test suites pass: `for f in tests/*.test.mjs; do node "$f" || exit 1; done`
- [ ] New or changed behaviour has tests where it can be tested in Node (flight models, missions, navigation, UI logic).
- [ ] Visual changes: screenshots above; the quality gate (`node tools/perf/refshots.mjs gate`) passes, or its heat maps are attached.
- [ ] Phones still run well (touch controls, the phone profile of `tools/perf/matrix.mjs`, or a real phone).
- [ ] Player-facing text is in Turkish with correct diacritics (ç ğ ı İ ö ş ü).
- [ ] No personal data, secrets, local paths or third-party logos are committed; tools use a generic User-Agent.
- [ ] New third-party code, data, fonts or sounds have a compatible licence and are listed in NOTICE (and the Künye, if shown in the game).
