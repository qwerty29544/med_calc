# Прикладной контракт

Префикс `/api/v1`. Cookie session, JSON. Ошибки `{code,message}`. Демонстрационный режим всегда явный (`demo: true`), исходники DRAFT не объявлять PUBLISHED. Разработка: web 3000 → proxy API 3001. Docker: web localhost:8080 → внутренний API 3001. GET `/openapi.json` возвращает документ OpenAPI аутентифицированному пользователю.

GET `/catalog` → `{nosologies:[{nosology_code,name_ru}],facts:FactDefinition[],demo:boolean,versions:Record<string,string>}`. Не отдавать граф/AST браузеру.
POST `/auth/login` `{login,password}` → `{user:{id,login,name,role}}`; GET `/auth/me` такой же ответ; POST `/auth/logout`.
GET `/cases` → `CaseDraft[]`; POST `/cases` `{nosology_code}` → CaseDraft; GET/PATCH `/cases/:id` (PATCH `{facts?,medications?}`) → CaseDraft.
CaseDraft `{id,nosology_code,facts:Record<string,FactValue>,medications:{state:'UNKNOWN'|'KNOWN_NONE'|'KNOWN_LIST',drug_ids:number[],unrecognized:string[]},created_at,updated_at}`.
FactValue `{state:'KNOWN'|'UNKNOWN'|'NOT_ASSESSED',value:boolean|number|string|null,unit?:string|null}`. UNKNOWN обязателен null. FactDefinition `{fact_code,label_ru,data_type,unit?,enum_values?,min_value?,max_value?}`.
POST `/cases/:id/evaluate-preview` без тела → EvaluationView с `preview_token` (SHA-256 ревизии случая и предварительного результата).
POST `/cases/:id/evaluations` без тела сохраняет результат как прежде. Необязательное тело `{preview_token?,feedback?:{request_id,agreement,used,comment}}` позволяет сохранить результат и отзыв одной транзакцией. Для отзыва токен обязателен; `request_id` — UUID попытки, повтор с тем же содержимым возвращает тот же результат. Изменение тела при повторном ключе → `409 FEEDBACK_REQUEST_CONFLICT`; изменение данных/правил после показа → `409 PREVIEW_CHANGED`; отзыв к незавершённому результату → `409 RESULT_NOT_COMPLETE`. Повтор уже успешно сохранённой попытки возвращает первоначальный снимок, даже если исходный черновик позже изменился.
EvaluationView `{id?,case_id,status:'COMPLETED'|'NEEDS_INPUT'|'FAILED',missing_facts:string[],questions:FactDefinition[],outcome:{type:'TREATMENT_SCHEME',scheme_id}|{type:'TERMINAL_STATE',terminal_code}|null,title:string,options:TherapyOption[],warnings:string[],explanation:string[],copy_text:string,trace:unknown[],versions:Record<string,string>,hashes:Record<string,string>,demo:boolean,created_at?:string,safety_status:string}`.
TherapyOption `{option_id,drug_id,drug_name,line,source_text,regimen:object,eligibility:'ELIGIBLE'|'BLOCKED'|'REVIEW_REQUIRED',action:'ALLOW'|'WARN'|'BLOCK'|'REVIEW_REQUIRED',findings:{message,action,source?}[],dose_status:string}`.
GET `/evaluations` → EvaluationView[]; GET `/evaluations/:id` → EvaluationView; GET `/evaluations/:id/trace` → trace; GET `/evaluations/:id/explanation` → explanation.
GET `/drugs/search?q=` → `{drug_id,generic_name_ru,normalized_code,aliases:string[]}[]`; GET `/drugs/:id` → drug.
POST `/evaluations/:id/feedback` `{agreement:'AGREE'|'DISAGREE',used:boolean,comment:string}` → feedback; GET тот же маршрут → feedback[].
POST `/exports/evaluations` `{format:'csv'|'xlsx'}` → файл.
GET `/admin/packages` → PackageView[] `{id,package_type,version,status,sha256,active,validation_report?,payload?}`; POST `/admin/packages/import` `{payload:unknown}`; POST `/:id/validate`; POST `/:id/publish` `{approval_note:string,golden_cases:array}`; POST `/:id/activate`; GET `/:id/validation`. POST `/admin/packages/activate-set` `{package_ids:string[]}` атомарно активирует совместимый набор опубликованных версий.
GET `/admin/users` → users; POST `/admin/users` `{login,name,password,role}`; PATCH `/admin/users/:id` `{role?,active?}`.

Роли DOCTOR, CLINICAL_PHARMACOLOGIST, CLINICAL_ADMIN, SYSTEM_ADMIN. Медицинские данные врача ограничены его случаями; клинический администратор/фармаколог может просматривать в расширенной роли с аудитом; SYSTEM_ADMIN управляет пользователями, без права публикации медицинских правил.

## Доменная точка входа для API

`packages/clinical/src/service.ts`: `loadContent(root?:string): ClinicalContent`; `preview(content, draft): EvaluationView`; `validatePackage(payload): ValidationReport`; `compileAuthoring(authoring): RulePackage`. loadContent читает content/canonical/clinical-rules.json и справочники; это I/O оболочка, ядро чистое. `preview` детерминирован, принимает {id,nosology_code,facts,medications}; default DRAFT доступен только если API явно использует demo. `content.rules` содержит canonical RulePackage, `content.drugs` справочник. API может заменить rules на проверенный опубликованный payload при активации. Типы в `packages/contracts/src/index.ts`.

