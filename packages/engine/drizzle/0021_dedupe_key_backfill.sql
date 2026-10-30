-- Every launch claimed before each claim carried its dedupe key gets the one its repo and ref imply,
-- as dedupeKeyOf (src/launch-keys.ts) computes it: an article by its slug, a repo gone public by the
-- repo, a release by repo and tag. Only fills empty keys; a key another row holds already, or that
-- two old rows would share (a repo gone public by webhook and by poll), goes to the oldest row alone,
-- so the unique constraint never fails the migration.
UPDATE "launches" AS l SET "dedupe_key" = k."key"
FROM (
	SELECT DISTINCT ON (c."key") c."id", c."key"
	FROM (
		SELECT "id",
			CASE
				WHEN "ref" LIKE 'article:%' THEN "ref"
				WHEN "ref" LIKE 'public:%' THEN 'github-public:' || "repo"
				ELSE 'github-release:' || "repo" || '@' || "ref"
			END AS "key"
		FROM "launches"
		WHERE "dedupe_key" IS NULL
	) AS c
	WHERE NOT EXISTS (SELECT 1 FROM "launches" AS t WHERE t."dedupe_key" = c."key")
	ORDER BY c."key", c."id"
) AS k
WHERE l."id" = k."id";
