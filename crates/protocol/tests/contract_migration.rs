//! The migration export manifest and its SQL values (`migration.proto`).

use armadra_protocol::v1::*;
use prost::Message;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../proto/fixtures/{name}.hex"));
    let hex = std::fs::read_to_string(path).unwrap();
    hex.trim()
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn check<M: Message + Default + PartialEq + std::fmt::Debug>(name: &str, expected: M) {
    let wire = fixture(name);
    assert_eq!(M::decode(wire.as_slice()).unwrap(), expected);
    assert_eq!(
        expected.encode_to_vec(),
        wire,
        "{name} differs across runtimes"
    );
}

#[test]
fn migration_manifest_and_sql_values_round_trip() {
    check(
        "migration_manifest",
        MigrationExportManifest {
            format_version: 1,
            export_id: "导出-1".into(),
            exported_at_unix_ms: 1_788_557_000_000,
            producer_version: "0.1.0".into(),
            database_file: "source.sqlite".into(),
            database_bytes: 9_007_199_254_740_993,
            database_sha256: vec![1; 32],
            migrations: vec![ExportMigration {
                version: 1,
                checksum: vec![2; 48],
                success: true,
                description: "initial".into(),
            }],
            tables: vec![ExportTable {
                name: "boards".into(),
                row_count: 2,
                readable: true,
                schema_sha256: vec![3; 32],
            }],
            assets_complete: true,
            ..Default::default()
        },
    );
    use imported_sql_column::Value;
    check(
        "imported_sql_row",
        ImportedSqlRow {
            table: "测试".into(),
            columns: vec![
                ImportedSqlColumn {
                    name: "null".into(),
                    value: Some(Value::NullValue(SqlNull {})),
                },
                ImportedSqlColumn {
                    name: "text".into(),
                    value: Some(Value::TextValue("会话😀".into())),
                },
                ImportedSqlColumn {
                    name: "integer".into(),
                    value: Some(Value::IntegerValue(i64::MIN)),
                },
                ImportedSqlColumn {
                    name: "real".into(),
                    value: Some(Value::RealValue(1.5)),
                },
                ImportedSqlColumn {
                    name: "blob".into(),
                    value: Some(Value::BlobValue(vec![0, 255])),
                },
            ],
        },
    );
}
