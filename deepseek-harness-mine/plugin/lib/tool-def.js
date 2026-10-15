// DSH IDE — 自带的工具定义器（等价官方 @deepseek-ai/dsh-tools 的 defineTool）
//
// 为什么自带：引擎按 pnpm 工作区规则解析官方包，本插件目录不在工作区内，裸 import 必然失败，
// 而失败会被当成普通告警吞掉 —— 2026-10-13「浏览器工具整批消失」即此因。
// 本文件只依赖引擎的公开契约（ToolDefinition = name/description/parameters 为 JSON Schema/
// output{schema,render}/execute），不随引擎检出位置、profile 布局、安装方式变化。
//
// 支持的作者糖子集＝插件实际用法。要加新糖（type:'json'、嵌套 oneOf 等）之前，先回引擎
// packages/core/tools/src/schema.ts 核对官方编译语义，别照想象写。
// 与官方的已知差异：官方 ToolArgsError 是引擎 HarnessError 子类、带结构化 code INVALID_ARGS；
// 这里只能抛普通 Error（文案同构、无 code），引擎取不到 code，但仍按 isError 回报模型。

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (target, key) => Object.prototype.hasOwnProperty.call(target, key)

function copyAnnotations(from, to) {
  for (const key of ANNOTATION_KEYS) {
    if (has(from, key)) to[key] = from[key]
  }
}

/** 属性级 required: true 上提为同层 required 数组——糖与 JSON Schema 之间唯一的形态差异。 */
function compilePropertyMap(spec, path) {
  if (!isRecord(spec)) throw new Error(`${path} must be an object of value schemas`)
  const properties = {}
  const required = []
  for (const key of Object.keys(spec)) {
    const property = spec[key]
    if (!isRecord(property)) throw new Error(`${path}.${key} must be a value schema object`)
    if (has(property, 'required') && property.required !== true) {
      throw new Error(`${path}.${key}.required must be true when present`)
    }
    if (property.required === true) required.push(key)
    properties[key] = compileValue(property, `${path}.${key}`)
  }
  return { properties, required }
}

function compileValue(spec, path) {
  if (!isRecord(spec)) throw new Error(`${path} must be a value schema object`)
  const node = {}
  if (has(spec, 'oneOf')) {
    if (has(spec, 'type')) throw new Error(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
      throw new Error(`${path}.oneOf must be an array of at least two value schemas`)
    }
    copyAnnotations(spec, node)
    node.oneOf = spec.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`))
    return node
  }
  if (spec.type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be explicitly true or false`)
    }
    node.type = 'object'
    copyAnnotations(spec, node)
    node.additionalProperties = spec.additionalProperties
    if (has(spec, 'properties')) {
      const compiled = compilePropertyMap(spec.properties, `${path}.properties`)
      node.properties = compiled.properties
      if (compiled.required.length > 0) node.required = compiled.required
    }
    return node
  }
  if (spec.type === 'array') {
    node.type = 'array'
    copyAnnotations(spec, node)
    if (has(spec, 'items')) node.items = compileValue(spec.items, `${path}.items`)
    return node
  }
  if (SCALAR_TYPES.includes(spec.type)) {
    node.type = spec.type
    copyAnnotations(spec, node)
    if (has(spec, 'enum')) {
      if (!Array.isArray(spec.enum)) throw new Error(`${path}.enum must be an array of scalar values`)
      node.enum = [...spec.enum]
    }
    if (has(spec, 'const')) node.const = spec.const
    return node
  }
  throw new Error(`${path}.type must be string/number/integer/boolean/null/array/object, or use oneOf`)
}

/** 隐式开放对象根：官方不写 additionalProperties，此处同样不写。 */
function compileParameters(spec) {
  const compiled = compilePropertyMap(spec, 'parameters')
  return {
    type: 'object',
    properties: compiled.properties,
    ...compiled.required.length > 0 ? { required: compiled.required } : {},
  }
}

function validateValue(schema, value, path) {
  const at = path === '' ? 'arguments' : path
  const violations = []
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((branch) => validateValue(branch, value, at).length === 0)
    if (matched.length !== 1) violations.push(`${at} must match exactly one of the allowed shapes`)
    return violations
  }
  if (has(schema, 'enum') && !schema.enum.includes(value)) {
    violations.push(`${at} must be one of ${JSON.stringify(schema.enum)}`)
  }
  if (has(schema, 'const') && value !== schema.const) {
    violations.push(`${at} must be ${JSON.stringify(schema.const)}`)
  }
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return [...violations, `${at} must be an object`]
      for (const key of schema.required || []) {
        if (!has(value, key)) violations.push(`${at}.${key} is required`)
      }
      const properties = schema.properties || {}
      for (const key of Object.keys(value)) {
        if (has(properties, key)) violations.push(...validateValue(properties[key], value[key], `${at}.${key}`))
        else if (schema.additionalProperties === false) violations.push(`${at}.${key} is not allowed`)
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [...violations, `${at} must be an array`]
      if (has(schema, 'items')) {
        value.forEach((item, index) => violations.push(...validateValue(schema.items, item, `${at}[${index}]`)))
      }
      return violations
    }
    case 'string':
      if (typeof value !== 'string') violations.push(`${at} must be a string`)
      return violations
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${at} must be a number`)
      return violations
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${at} must be an integer`)
      return violations
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${at} must be a boolean`)
      return violations
    case 'null':
      if (value !== null) violations.push(`${at} must be null`)
      return violations
    default:
      return violations
  }
}

export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

export function defineTool(options) {
  if (!isRecord(options) || typeof options.name !== 'string' || typeof options.description !== 'string') {
    throw new TypeError('defineTool requires { name, description, parameters, output, execute }')
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError(`defineTool(${options.name}): execute must be a function`)
  }
  const output = options.output
  if (!isRecord(output) || typeof output.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output must declare { schema, render }`)
  }
  const parameters = compileParameters(options.parameters)
  const schema = compileValue(output.schema, 'schema')
  const execute = options.execute
  const render = output.render
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema,
      render: (args, value) => render(args, value),
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, '')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return execute(args, exec)
    },
  }
}
