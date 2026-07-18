# Profile-provider canary ambiguous start 수동 해소

이 절차는 replacement profile canary 원장이 `state = 'ambiguous'`, `run_id IS NULL`인
경우에만 사용한다. 이 상태에서는 Actor가 생성되지 않았다고 추정하지 않으며 새 Actor를
시작하지 않는다. resolver에는 Actor start API 호출 경로가 없다.

## 권한과 데이터 경계

- service-role은 canary experiment/run 원장의 owner-filtered RPC를 읽는 데만 사용한다.
  `resolve_analysis_v2_profile_provider_canary_adopt_run`과
  `resolve_analysis_v2_profile_provider_canary_no_run`은 `service_role`, `anon`,
  `authenticated` 실행 권한이 모두 취소된 DB-owner 전용 함수다.
- resolver는 DB를 변경하지 않는다. 검토 가능한 owner SQL artifact만 생성한다. SQL을
  실행할 때도 직접 `UPDATE`, `INSERT`, `DELETE`하지 않고 owner 전용 함수만 호출한다.
- stdout은 repetition, 고정된 판정 결과, artifact 생성 여부, Actor start count 0만
  포함한다. request/run ID, ordered HMAC, username, URL, email, token, evidence hash, artifact
  경로는 출력하지 않는다.
- evidence reference와 SQL artifact는 source tree 밖 운영자 지정 절대 경로에 둔다. SQL
  artifact는 새 파일을 mode `0600`으로 만들며 기존 파일을 덮어쓰지 않는다. 기존 파일이
  byte-for-byte 같고 mode가 `0600`인 멱등 재실행만 허용한다.

## 1. 사전 준비

운영자 보안 저장소에 사용자 데이터가 없는 incident/ticket reference 한 줄을 저장한다.
파일은 1~4096 bytes여야 하며 원문은 DB나 stdout에 남지 않고 SHA-256만 owner 함수에
전달된다.

운영 환경에는 다음 값이 환경변수로만 있어야 한다.

- Supabase URL과 service-role key: ambiguous reservation 읽기 전용
- `APIFY_PRIMARY_API_TOKEN`: 정확한 primary 계정의 run/KVS 읽기 전용
- `ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET`: canary 예약 당시와 같은 numeric secret

토큰, HMAC secret, request ID를 로그나 ticket에 복사하지 않는다. primary credential이나
HMAC secret을 회전했다면 기존 ambiguous row를 추정으로 해소하지 말고 credential
retirement 절차에서 먼저 매핑을 복구한다.

## 2. resolver 실행

식별값과 경로는 운영자 보안 저장소에서 환경변수로 주입한다. 값을 명령줄에 직접
붙여 넣지 않으며 shell tracing을 먼저 끈다. SQL 출력 경로의 부모 directory는 이미
존재해야 하며 repository 밖이어야 한다.

```bash
set +x
npm run canary:instagram-profile-provider:resolve -- \
  --source-request-id="${PROFILE_PROVIDER_CANARY_SOURCE_REQUEST_ID}" \
  --repetition='1' \
  --evidence-reference-file="${PROFILE_PROVIDER_CANARY_EVIDENCE_REFERENCE_FILE}" \
  --sql-output-file="${PROFILE_PROVIDER_CANARY_SQL_OUTPUT_FILE}" \
  --confirm-ambiguous-start-resolution
```

resolver는 다음 순서의 읽기만 수행한다.

1. exact canary version의 ambiguous reservation과 experiment HMAC을 읽는다.
2. `apify/instagram-scraper`, build `0.0.692`, credential slot `primary`를 고정한다.
3. `ambiguous_at`이 최소 2분 지난 후에만 `reserved_at - 60초`부터
   `ambiguous_at + 60초`까지의 고정 window를 조회한다. 한 window의 후보가 100개를
   초과하면 전체성을 증명할 수 없으므로 중단한다.
4. 모든 exact-build 후보의 KVS `INPUT`이 정확히
   `{ directUrls, resultsType: 'details' }`이고 URL 15개의 ordered HMAC과 일치하는지
   확인한다. 다른 build의 run은 exact 후보 수에 포함하지 않는다.
5. 첫 전체-window 조회가 0개면 10초 후 동일 window를 다시 조회한다.
   두 번 모두 0개일 때만 no-run artifact를 생성한다.

판정은 fail-closed다.

- 2분 age floor와 10초 간격의 전체-window 조회가 모두 후보 0개:
  `owner_sql_artifact_written`, `artifact_kind = verified_no_run`
- exact 후보 1개: `owner_sql_artifact_written`, `artifact_kind = adopt_run`
- exact 후보 2개 이상: `blocked_multiple_candidates`, artifact 없음
- 첫 조회는 0개였지만 두 번째 조회에 후보가 나타남:
  `blocked_candidate_set_unstable`, artifact 없음
- Actor/build/time/INPUT/HMAC mismatch: `blocked_input_mismatch`, artifact 없음
- provider 또는 원장 read 오류: fixed error code만 반환하고 artifact 없음

어떤 경로도 Actor를 시작, resurrect, reboot 또는 retry하지 않는다.

## 3. owner SQL 검토와 실행

artifact를 열어 다음을 확인한다.

- 단일 `SELECT public.resolve_analysis_v2_profile_provider_canary_*` 호출만 존재함
- direct DML과 username/Instagram URL이 없음
- adopt 경로는 exact Actor/build/primary/run-start/HMAC identity를 전달함
- no-run 경로는 exact reservation identity와 evidence reference hash를 전달함

검토 후 Supabase SQL Editor의 프로젝트 DB-owner 세션 또는 동등한 owner 직접 연결에서만
실행한다. service-role REST/PostgREST로 실행하면 권한 오류가 나야 한다.

owner 함수는 row를 잠그고 불변 identity를 다시 확인한다. 같은 identity와 evidence hash의
재호출만 멱등 성공하며 다른 run/evidence/state는 충돌로 실패한다.

## 4. 사후 처리

- adopt: 저장된 동일 run ID만 resume하여 terminal 결과와 실제 비용을 대사하고 KVS,
  dataset, request queue를 삭제·부재 확인한다. 새 Actor를 시작하지 않는다.
- verified no-run: canary를 `verified_no_run` terminal path로 진행하고 source storage cleanup과
  experiment HMAC clearing을 완료한다. repetition 2를 만들지 않는다.
- multiple/mismatch: 원장을 ambiguous 상태로 유지하고 primary 계정의 전체 run history와
  credential/version 매핑을 별도 incident에서 조사한다.

마지막으로 experiment가 `experiment_terminal`이고 모든 source/canary storage가
`verified_absent`인지 확인한다. SQL artifact에는 민감한 identity가 있으므로 승인된 운영
증거 보존 정책에 따라 제한 저장하고, 불필요해진 사본은 복구 가능한 보안 삭제 절차로
제거한다.
