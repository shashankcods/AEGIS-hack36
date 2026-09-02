# AEGIS Training Data

These CSV files contain curated prototype data for the two AEGIS text classifiers.

## Labels

- `label = 1`: the text discloses sensitive information about the speaker or another specific person.
- `label = 0`: the text is educational, hypothetical, fictional, anonymized, or unrelated and does not disclose a specific person's information.

The `category` column is used to check that the dataset contains different types of positive and negative examples.

## Files

- `health_disclosure_dataset.csv`: 400 balanced examples covering personal health, symptoms, test results, medication, treatment, disability, and mental-health disclosures.
- `self_harm_disclosure_dataset.csv`: 400 balanced examples covering current, past, indirect, and help-seeking self-harm disclosures, along with contextual and non-risk examples.

The health notebook creates a seeded 280/60/60 train, validation, and test split. The self-harm CSV contains a fixed balanced split of 272/64/64.

## Limitations

The examples are manually curated and are suitable for a prototype, not clinical use. They do not replace a larger independently annotated dataset. AEGIS uses these models only to warn users about potentially sensitive text; it does not diagnose disease or assess clinical risk.
