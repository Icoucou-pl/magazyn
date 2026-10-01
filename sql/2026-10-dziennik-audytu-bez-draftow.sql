-- Jednorazowo: wpisy dziennika z dzisiejszego wieczoru, które pokazały roboczy numer „Draft-…”.
-- „kontenera Draft-X (#103)” → nr kontenera, a jeśli go nie ma — „FV <nr FV>”; w tabelce Draft → „—”.
WITH k AS (
    SELECT c.id,
           CASE WHEN c.container_number IS NOT NULL AND c.container_number !~* '^draft-' THEN c.container_number
                WHEN NULLIF(TRIM(c.order_number), '') IS NOT NULL THEN 'FV ' || TRIM(c.order_number)
                ELSE COALESCE('FV ' || (SELECT l.order_number FROM app_container_lots l
                                         WHERE l.container_id = c.id AND NULLIF(TRIM(l.order_number), '') IS NOT NULL
                                         ORDER BY l.position, l.id LIMIT 1), '#' || c.id)
           END AS etykieta
    FROM app_containers c
)
UPDATE app_audit_log a
SET message = regexp_replace(a.message, 'Draft-\S+ \(#' || k.id || '\)', k.etykieta),
    changes = (SELECT jsonb_agg(CASE WHEN x->>'pole' = 'Numer kontenera'
                                     THEN jsonb_build_object('pole', x->>'pole',
                                            'bylo', CASE WHEN x->>'bylo' ~* '^draft-' THEN '—' ELSE x->>'bylo' END,
                                            'jest', CASE WHEN x->>'jest' ~* '^draft-' THEN '—' ELSE x->>'jest' END)
                                     ELSE x END)
               FROM jsonb_array_elements(a.changes) x)
FROM k
WHERE a.message ~ ('Draft-\S+ \(#' || k.id || '\)');

-- Zmiana z jednego roboczego numeru na drugi to nie zmiana — wiersz „— → —” wypada z tabelki.
UPDATE app_audit_log
SET changes = (SELECT jsonb_agg(x) FROM jsonb_array_elements(changes) x
               WHERE NOT (x->>'pole' = 'Numer kontenera' AND x->>'bylo' = '—' AND x->>'jest' = '—'))
WHERE changes @> '[{"pole": "Numer kontenera", "bylo": "—", "jest": "—"}]';

-- Po wyrzuceniu tego wiersza została jedna zmiana — zdanie jak dla pojedynczej zmiany.
UPDATE app_audit_log
SET message = regexp_replace(message, 'zmienił \d+ pol(a|e|ól) (kontenera .*)$',
                             'zmienił „' || (changes->0->>'pole') || '” \2: ' || (changes->0->>'bylo') || ' → ' || (changes->0->>'jest'))
WHERE area = 'Kontenery' AND jsonb_array_length(changes) = 1 AND message ~ 'zmienił \d+ pol(a|e|ól) kontenera ';

SELECT id, message, changes FROM app_audit_log WHERE created_at > NOW() - INTERVAL '1 day' AND area = 'Kontenery' ORDER BY id DESC LIMIT 10;
