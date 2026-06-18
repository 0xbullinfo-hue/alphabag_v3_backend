#!/usr/bin/env node

/**
 * OpenAPI Contract Validation Script
 * 
 * Runs pre-commit checks to ensure API contract integrity:
 * 1. OpenAPI spec is valid YAML
 * 2. All endpoints have documented request/response schemas
 * 3. All $refs are defined in components.schemas
 * 4. No breaking changes detected
 * 
 * Usage:
 *   node scripts/validate-openapi.js
 * 
 * Exit codes:
 *   0: All checks passed
 *   1: Validation failed
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const SPEC_PATH = path.join(ROOT, 'openapi.yaml');
const LAST_SPEC_PATH = path.join(ROOT, '.openapi.last.yaml');

let errors = [];
let warnings = [];

const log = (msg) => console.log(`  ${msg}`);
const error = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

console.log('\n🔍 OpenAPI Contract Validation\n');

// 1. Load and parse OpenAPI spec
console.log('1️⃣  Parsing OpenAPI specification...');
let spec;
try {
    const content = fs.readFileSync(SPEC_PATH, 'utf-8');
    spec = yaml.load(content);
    log(`✓ OpenAPI spec loaded (version ${spec.info.version})`);
} catch (err) {
    error(`Failed to load or parse OpenAPI spec: ${err.message}`);
    console.log(`\n❌ Validation failed with ${errors.length} error(s)\n`);
    errors.forEach(e => console.log(`   • ${e}`));
    process.exit(1);
}

// 2. Validate spec structure
console.log('\n2️⃣  Validating spec structure...');
if (!spec.openapi || !spec.openapi.startsWith('3.0')) {
    error('Invalid OpenAPI version. Expected 3.0.x');
}
if (!spec.info || !spec.info.title) {
    error('Missing required field: info.title');
}
if (!spec.paths || Object.keys(spec.paths).length === 0) {
    error('No paths defined in OpenAPI spec');
}
if (!spec.components || !spec.components.schemas) {
    error('Missing components.schemas in OpenAPI spec');
}
if (errors.length === 0) {
    log(`✓ Spec structure valid`);
    log(`✓ Endpoints: ${Object.keys(spec.paths).length}`);
    log(`✓ Schemas: ${Object.keys(spec.components.schemas).length}`);
}

// 3. Validate endpoint documentation
console.log('\n3️⃣  Checking endpoint documentation...');
let endpointCount = 0;
let undocumentedResponses = 0;

Object.entries(spec.paths).forEach(([path, pathItem]) => {
    Object.entries(pathItem).forEach(([method, operation]) => {
        if (typeof operation !== 'object') return;
        endpointCount++;

        // Check for responses
        if (!operation.responses) {
            error(`${method.toUpperCase()} ${path}: No responses documented`);
            return;
        }

        // Check for 200/2xx response
        const successResponse = operation.responses['200'] || 
                               Object.keys(operation.responses).find(code => code.startsWith('2'));
        if (!successResponse) {
            warn(`${method.toUpperCase()} ${path}: No 2xx response documented`);
            undocumentedResponses++;
            return;
        }

        // Check for response schema
        const schema = operation.responses[Object.keys(operation.responses)[0]]?.content?.['application/json']?.schema;
        if (!schema) {
            warn(`${method.toUpperCase()} ${path}: No response schema defined`);
            undocumentedResponses++;
        }
    });
});

if (undocumentedResponses === 0) {
    log(`✓ All ${endpointCount} endpoints have documented responses`);
} else {
    warn(`${undocumentedResponses}/${endpointCount} endpoints missing full documentation`);
}

// 4. Validate schema references
console.log('\n4️⃣  Validating schema references...');
const schemas = spec.components.schemas;
const definedSchemaNames = Object.keys(schemas);
const referencedSchemas = new Set();
let unresolvedRefs = 0;

const collectRefs = (obj) => {
    if (!obj) return;
    if (obj.$ref) {
        const schemaName = obj.$ref.split('/').pop();
        referencedSchemas.add(schemaName);
        if (!definedSchemaNames.includes(schemaName)) {
            error(`Unresolved $ref: ${obj.$ref}`);
            unresolvedRefs++;
        }
    }
    if (Array.isArray(obj)) {
        obj.forEach(collectRefs);
    } else if (typeof obj === 'object') {
        Object.values(obj).forEach(collectRefs);
    }
};

collectRefs(spec);

if (unresolvedRefs === 0) {
    log(`✓ All ${referencedSchemas.size} schema references resolved`);
} else {
    log(`✗ ${unresolvedRefs} unresolved schema references found`);
}

// 5. Check for breaking changes
console.log('\n5️⃣  Checking for breaking changes...');
if (fs.existsSync(LAST_SPEC_PATH)) {
    try {
        const lastContent = fs.readFileSync(LAST_SPEC_PATH, 'utf-8');
        const lastSpec = yaml.load(lastContent);
        
        let breaking = 0;

        // Check for removed endpoints
        Object.keys(lastSpec.paths || {}).forEach(path => {
            if (!spec.paths[path]) {
                error(`BREAKING: Endpoint removed: ${path}`);
                breaking++;
            }
        });

        // Check for removed required fields in schemas
        Object.entries(lastSpec.components.schemas || {}).forEach(([name, lastSchema]) => {
            const currentSchema = schemas[name];
            if (!currentSchema) return;

            const lastRequired = lastSchema.required || [];
            const currentRequired = currentSchema.required || [];

            lastRequired.forEach(field => {
                if (!currentRequired.includes(field)) {
                    error(`BREAKING: Required field removed from ${name}: ${field}`);
                    breaking++;
                }
            });
        });

        if (breaking === 0) {
            log(`✓ No breaking changes detected`);
        } else {
            log(`✗ ${breaking} breaking change(s) detected`);
        }
    } catch (err) {
        warn(`Could not check for breaking changes: ${err.message}`);
    }
} else {
    log(`ℹ No previous spec found (first run)`);
}

// 6. Save current spec for next run
try {
    fs.writeFileSync(LAST_SPEC_PATH, fs.readFileSync(SPEC_PATH, 'utf-8'));
    log('✓ Spec snapshot saved for next validation');
} catch (err) {
    warn(`Could not save spec snapshot: ${err.message}`);
}

// Summary
console.log('\n' + '─'.repeat(60));
if (errors.length > 0) {
    console.log(`\n❌ Validation failed with ${errors.length} error(s)\n`);
    errors.forEach(e => console.log(`   • ${e}`));
    if (warnings.length > 0) {
        console.log(`\n⚠️  ${warnings.length} warning(s):\n`);
        warnings.forEach(w => console.log(`   • ${w}`));
    }
    process.exit(1);
} else if (warnings.length > 0) {
    console.log(`\n✅ Validation passed with ${warnings.length} warning(s)\n`);
    warnings.forEach(w => console.log(`   • ${w}`));
    process.exit(0);
} else {
    console.log(`\n✅ All contract validation checks passed!\n`);
    console.log(`   • Version: ${spec.info.version}`);
    console.log(`   • Endpoints: ${Object.keys(spec.paths).length}`);
    console.log(`   • Schemas: ${Object.keys(spec.components.schemas).length}`);
    console.log(`   • Schema Refs: ${referencedSchemas.size}`);
    console.log();
    process.exit(0);
}
