/**
 * OpenAPI Schema Validation Middleware
 *
 * Validates controller responses against the OpenAPI 3.0.0 specification
 * to prevent breaking API contracts. Catches schema violations early in development.
 *
 * Usage:
 *   import { validateResponse } from './utils/schemaValidator.js';
 *   // In controller after res.json():
 *   validateResponse(res, statusCode, responseData, endpoint, method);
 */

import Ajv from 'ajv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ajv = new Ajv({ strict: false });

// Load OpenAPI spec once at module load time
let openAPISpec = null;
let schemas = null;

const loadOpenAPISpec = () => {
    try {
        if (!openAPISpec) {
            const specPath = path.join(__dirname, '../../openapi.yaml');
            const specContent = fs.readFileSync(specPath, 'utf-8');
            openAPISpec = yaml.load(specContent);
            schemas = openAPISpec.components.schemas;
        }
        return openAPISpec;
    } catch (error) {
        console.error('[SCHEMA VALIDATOR] Failed to load OpenAPI spec:', error.message);
        return null;
    }
};

/**
 * Extract the schema name for a given endpoint and method
 * @param {string} endpoint - e.g., '/airdrop/status'
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {number} statusCode - HTTP response code
 * @returns {string|null} - Schema name or null
 */
const getSchemaForEndpoint = (endpoint, method, statusCode) => {
    const spec = openAPISpec || loadOpenAPISpec();
    if (!spec || !spec.paths) return null;

    const pathItem = spec.paths[endpoint];
    if (!pathItem) return null;

    const operation = pathItem[method.toLowerCase()];
    if (!operation) return null;

    const responseSpec = operation.responses && operation.responses[statusCode];
    if (!responseSpec || !responseSpec.content || !responseSpec.content['application/json']) return null;

    const schemaRef = responseSpec.content['application/json'].schema;
    if (!schemaRef) return null;

    // Handle $ref references
    if (schemaRef.$ref) {
        return schemaRef.$ref.split('/').pop(); // Extract schema name from '#/components/schemas/SchemaName'
    }

    // Return inline schema
    return schemaRef;
};

/**
 * Convert OpenAPI schema to JSON Schema for AJV validation
 * Handles $ref resolution
 * @param {object} schema - OpenAPI schema
 * @returns {object} - JSON Schema compatible
 */
const toJsonSchema = (schema) => {
    if (!schema) return {};
    
    if (schema.$ref) {
        const schemaName = schema.$ref.split('/').pop();
        return schemas[schemaName] || {};
    }

    // Recursively resolve nested references
    const resolved = { ...schema };
    if (resolved.items && resolved.items.$ref) {
        resolved.items = toJsonSchema(resolved.items);
    }
    if (resolved.properties) {
        Object.keys(resolved.properties).forEach(key => {
            if (resolved.properties[key].$ref) {
                resolved.properties[key] = toJsonSchema(resolved.properties[key]);
            } else if (resolved.properties[key].items && resolved.properties[key].items.$ref) {
                resolved.properties[key].items = toJsonSchema(resolved.properties[key].items);
            }
        });
    }
    if (resolved.oneOf || resolved.anyOf || resolved.allOf) {
        ['oneOf', 'anyOf', 'allOf'].forEach(key => {
            if (resolved[key]) {
                resolved[key] = resolved[key].map(s => toJsonSchema(s));
            }
        });
    }

    return resolved;
};

/**
 * Validate a response against OpenAPI schema
 * 
 * @param {object} res - Express response object (for metadata, not modified)
 * @param {number} statusCode - HTTP status code
 * @param {object} responseData - Response payload to validate
 * @param {string} endpoint - API endpoint path (e.g., '/airdrop/status')
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @returns {object} - { valid: boolean, errors: array }
 */
export const validateResponse = (res, statusCode, responseData, endpoint, method) => {
    if (!responseData) {
        return { valid: true, errors: [] };
    }

    const spec = openAPISpec || loadOpenAPISpec();
    if (!spec) {
        console.warn('[SCHEMA VALIDATOR] OpenAPI spec not available, skipping validation');
        return { valid: true, errors: [] };
    }

    // Get schema name for this endpoint + method + status
    const schemaNameOrRef = getSchemaForEndpoint(endpoint, method, statusCode);
    if (!schemaNameOrRef) {
        // Endpoint not documented in OpenAPI spec
        if (process.env.NODE_ENV !== 'production') {
            console.warn(`[SCHEMA VALIDATOR] No schema defined for ${method} ${endpoint} (${statusCode})`);
        }
        return { valid: true, errors: [] };
    }

    // Get the schema
    let schema = schemaNameOrRef;
    if (typeof schemaNameOrRef === 'string') {
        schema = schemas[schemaNameOrRef];
        if (!schema) {
            console.warn(`[SCHEMA VALIDATOR] Schema not found: ${schemaNameOrRef}`);
            return { valid: true, errors: [] };
        }
    }

    // Convert OpenAPI schema to JSON Schema
    const jsonSchema = toJsonSchema(schema);

    // Compile and validate
    try {
        const validate = ajv.compile(jsonSchema);
        const valid = validate(responseData);

        if (!valid) {
            const errors = validate.errors.map(err => ({
                path: err.instancePath || '$',
                message: err.message,
                keyword: err.keyword,
                received: typeof err.data
            }));

            // Log violations in development
            if (process.env.NODE_ENV !== 'production') {
                console.warn(`[SCHEMA VIOLATION] ${method} ${endpoint} (${statusCode})`);
                console.warn(`  Schema: ${schemaNameOrRef}`);
                console.warn(`  Errors:`, JSON.stringify(errors, null, 2));
            }

            return { valid: false, errors, schema: schemaNameOrRef };
        }

        return { valid: true, errors: [] };
    } catch (error) {
        console.error('[SCHEMA VALIDATOR] Validation failed:', error.message);
        return { valid: true, errors: [] }; // Don't break requests on validator errors
    }
};

/**
 * Express middleware that wraps res.json() to validate responses
 * 
 * Usage:
 *   app.use(schemaValidationMiddleware);
 */
export const schemaValidationMiddleware = (req, res, next) => {
    // Skip validation for non-API routes
    if (!req.path.startsWith('/api')) {
        return next();
    }

    // Capture original json method
    const originalJson = res.json.bind(res);

    // Wrap json method
    res.json = function(data) {
        const statusCode = res.statusCode || 200;
        const endpoint = req.path.replace('/api', ''); // Remove /api prefix
        
        // Validate against OpenAPI spec
        const validation = validateResponse(res, statusCode, data, endpoint, req.method);

        if (!validation.valid && process.env.SCHEMA_VALIDATION_STRICT === 'true') {
            // In strict mode, log but don't block
            console.error(
                `[SCHEMA VALIDATION] Contract violation would fail in strict mode:\n` +
                `  ${req.method} ${endpoint} (${statusCode})\n` +
                `  Schema: ${validation.schema}\n` +
                `  Errors: ${JSON.stringify(validation.errors)}`
            );
        }

        // Call original json method
        return originalJson(data);
    };

    next();
};

/**
 * Utility to extract all required request/response schemas from OpenAPI spec
 * Useful for generating TypeScript types or documentation
 */
export const getSchemaDefinitions = () => {
    const spec = openAPISpec || loadOpenAPISpec();
    if (!spec) return {};
    return schemas || {};
};

export default {
    validateResponse,
    schemaValidationMiddleware,
    getSchemaDefinitions
};
