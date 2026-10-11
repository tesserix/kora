# Food snapshot provenance

Prepared on 2026-10-12 from the public upstream files below. See [NOTICE.md](NOTICE.md) for attribution and reuse terms and [the expansion report](../../../docs/food-data-expansion.md) for validation and remaining gaps.

The 23 source snapshots contain 54,472 rows before the index deduplicates barcodes and exact name/brand pairs. Country labels describe the source market; they boost search ranking and never restrict which foods a user may find.

## Input files

| Input | Version / retrieval | SHA-256 |
|---|---|---|
| AFCD nutrient profiles | Release 3 | `14cb3e73dbf58987b440e6299624c0fefd7a4e61591fc1f753995d9534e0efc9` |
| AUSNUT nutrient profiles | 2023 | `374650afc59951009d5ddf48fe35f712467458eb07eef513ea9f54c8f110f317` |
| AUSNUT food measures | 2023 | `58bee1204610efb72bb831dc7fb65acc23db540b51d056f83c6ac0ce84590475` |
| IFCT transcription | MIT tag 2.0.5 | `6ed9893f9695e1daba8623ec74c5f9b0b1b878f3aa4f1d648ddeab7260ccbf01` |
| USDA FNDDS CSV archive | 2024-10-31 | `5ccc25ec2777a8982fbb61378a42f415316173eb11e48c9a8ba4cb19f5a4f29c` |
| USDA SR Legacy JSON archive | 2018-04 | `0fe8ae486a2c8eb42cb96413f058deb51863a46c8fb8eeb4b1fb45006dd338ef` |
| UK CoFID workbook | 2021 | `436e9445ef2adb2a75f3d7edd51302de3adad25385f9795fc94ba58bd030e97d` |
| Japan MEXT English workbook | 2015 edition; revised English file 2017-12-25 | `5c968f1801f706b2970d51599ab2dce6f9e09ff3901fcf1990922960761885fb` |
| Open Food Facts compressed TSV export | retrieved 2026-10-12; upstream Last-Modified 2026-10-11 | `f72687ee8bc6522054fe69dbfda6b91902c16af1ec2e043cde27bc6c29ad8176` |

## Generated files

| File | Rows | SHA-256 |
|---|---:|---|
| afcd_release3.json | 1,588 | `edafe8fcdf330b90e83516a882c14ce11d085bd4fddf1ab22845c2fabd25da5d` |
| afcd_staples.json | 20 | `9309334410ce8be3fea9b90b2abb0a2579a8f96875bee7fd840d971e147ef52c` |
| au_in_dishes.json | 61 | `3ce57cc9bec3846809cb71b0714425ee55cdc28f2dc5e7ae19c3be82c59e97ca` |
| ausnut.json | 3,741 | `edfcc9d0d55ab94266744251b7db0dd77b30121b8604d35745b9745bbeaa48bc` |
| cofid_2021.json | 1,362 | `6df926dc3bd2d2d21e38932ac006690d8b0f7f620b6568049b48f66d15b6cf98` |
| ifct.json | 525 | `29e7584bd74695fab3ffd46cca7068910fa017ada9c849694fd9c54a7b4cd7ce` |
| in_dishes.json | 335 | `ee4f9d80a5049ed9f6a55751b4f589d7c381e19b8ce27280fb3d5fed9a65023d` |
| mext_2015.json | 1,916 | `eb09f995f50c7dfa0512749a495f96dea300e655600483ede30ac652be0d47b5` |
| off_ae.json | 603 | `79acc8fded98b1da49030420f65155fa46a2df97601c9f41c092589be4f1196b` |
| off_au.json | 5,666 | `6446a0f6e38f210b213d7fc165725689952498c5656607a263533221f9384ee3` |
| off_br.json | 5,000 | `94256312d204e70cac664ecb59fe77a904f051cb1fef984c9c4489017c0f1972` |
| off_fr.json | 5,000 | `37faf04c66bb5b532944126a1ff763b6787375b14224252e6b68177bab6b0d82` |
| off_gb.json | 5,000 | `318d49713d9820f053fb06445aea7ae4a8dd5e5eb3fefa7b1ab0dbae5c032c5e` |
| off_in.json | 870 | `63e40dcbe9883a78211bbdb18476a03740fe8ca39b396109940c42791bfb2038` |
| off_jp.json | 1,126 | `95a8a187bbf2c1740c41ecd9bc3b9b0361f38b13cbc7c474a72a88bd3c1b7e6a` |
| off_mx.json | 5,000 | `23c9dfec6023dd63dbae9703e12bcb2c0a3e67ad9aa14a9f992a07e2528c581b` |
| off_nz.json | 1,443 | `e2bb63881c3e46c7b1062983b982da2044feb58d7b1a30077fcb4add1d224569` |
| off_sg.json | 619 | `6c8f17d6cfd4c9e7ce8e9cbfb41173c8e1828ef90640bda91f94a700c97a894d` |
| off_th.json | 689 | `af5abeda7de463a2f01557b5d088096fdfa83aa0cc4321b1de2598ace1d6f530` |
| off_za.json | 711 | `e794ebd6395f8ed107c2d508d03ad643391c91a5305701417dfea65f82779ef3` |
| usda_common.json | 12 | `edd559d57b1c434010427e206e06aa883912d2a0a1b643d1898cb1deeac2ae64` |
| usda_fndds.json | 5,429 | `d5c2717c3af4857b961076bf5994a7cfc88c2b59617550a384ee744ac92757ef` |
| usda_sr_legacy.json | 7,756 | `7fa813c6d2d0ac4f11634e689e3447ce1febd82847d630cf4396bb941734b623` |

The small `afcd_staples.json`, `usda_common.json`, and `au_in_dishes.json` files remain the existing curated snapshots. `in_dishes.json` is regenerated from its committed recipe definitions and IFCT ingredients. New nutrient values are emitted only when every contributing ingredient has a value; unknown pantry or salt/spice values remain unknown. These recipes use raw-ingredient composition and cooked yield, without a heat-loss or leaching model.

## Reproduction

Run from `api/`, with OpenPyXL available. Download paths and source versions are documented in each converter. Verify the input hashes before reproducing these exact snapshots.

```sh
python3 scripts/afcd_convert.py <afcd-profiles.xlsx> > data/food/afcd_release3.json
python3 scripts/ausnut_convert.py <ausnut-profiles.xlsx> <ausnut-measures.xlsx> > data/food/ausnut.json
python3 scripts/ifct_convert.py <ifct-2.0.5-index.csv> > data/food/ifct.json
python3 scripts/fndds_convert.py <extracted-fndds-csv-directory> > data/food/usda_fndds.json
go run ./cmd/srconvert -in <sr-legacy.json> -out data/food/usda_sr_legacy.json
python3 scripts/in_dishes_convert.py --outdir data/food
python3 scripts/cofid_convert.py <cofid-2021.xlsx> > data/food/cofid_2021.json
python3 scripts/mext_convert.py <mext-2015-english.xlsx> > data/food/mext_2015.json
gzip -dc <off-export.csv.gz> | python3 scripts/off_convert.py --countries au,nz,in --outdir data/food
gzip -dc <off-export.csv.gz> | python3 scripts/off_convert.py --countries gb,fr,br,mx,za,ae,jp,sg,th --limit-per-country 5000 --outdir data/food
```

Use temporary output files and promote them only after each converter succeeds. OFF's new country snapshots prefer products with more published nutrient fields, then sort deterministically by name, brand and barcode. AU/NZ/IN retain every eligible product. The cap applies to snapshots; the weekly delta refresh can add further eligible products.
