import {
  type CodegenOptions as BaseCodegenOptions,
  type BaseCodegenResult,
  NewlineType,
  type Position,
  type SourceLocation,
  advancePositionWithMutation,
  locStub,
} from '@vue/compiler-dom'
import {
  type BlockFunctionIRNode,
  DynamicFlag,
  type IRDynamicInfo,
  IRNodeTypes,
  type OperationNode,
  type RootIRNode,
  type VaporHelper,
  type WithDirectiveIRNode,
} from './ir'
import { SourceMapGenerator } from 'source-map-js'
import { extend, isString } from '@vue/shared'
import type { ParserPlugin } from '@babel/parser'
import { genSetProp } from './generators/prop'
import { genCreateTextNode, genSetText } from './generators/text'
import { genSetEvent } from './generators/event'
import { genSetHtml } from './generators/html'
import { genSetRef } from './generators/ref'
import { genSetModelValue } from './generators/modelValue'
import { genAppendNode, genInsertNode, genPrependNode } from './generators/dom'
import { genWithDirective } from './generators/directive'
import { genIf } from './generators/if'

interface CodegenOptions extends BaseCodegenOptions {
  expressionPlugins?: ParserPlugin[]
}

// remove when stable
// @ts-expect-error
function checkNever(x: never): never {}

export interface CodegenContext {
  options: Required<CodegenOptions>

  source: string
  code: string
  line: number
  column: number
  offset: number
  indentLevel: number
  map?: SourceMapGenerator

  push(
    code: string,
    newlineIndex?: number,
    loc?: SourceLocation,
    name?: string,
  ): void
  newline(
    code?: string,
    newlineIndex?: number,
    loc?: SourceLocation,
    name?: string,
  ): void
  pushMulti(
    codes: [left: string, right: string, segment?: string],
    ...fn: Array<false | string | (() => void)>
  ): void
  pushCall(name: string, ...args: Array<false | string | (() => void)>): void
  withIndent(fn: () => void): void

  helpers: Set<string>
  vaporHelpers: Set<string>
  helper(name: string): string
  vaporHelper(name: string): string
}

function createCodegenContext(ir: RootIRNode, options: CodegenOptions) {
  const helpers = new Set<string>([])
  const vaporHelpers = new Set<string>([])
  const context: CodegenContext = {
    options: extend(
      {
        mode: 'function',
        prefixIdentifiers: options.mode === 'module',
        sourceMap: false,
        filename: `template.vue.html`,
        scopeId: null,
        optimizeImports: false,
        runtimeGlobalName: `Vue`,
        runtimeModuleName: `vue`,
        ssrRuntimeModuleName: 'vue/server-renderer',
        ssr: false,
        isTS: false,
        inSSR: false,
        inline: false,
        bindingMetadata: {},
        expressionPlugins: [],
      },
      options,
    ),

    source: ir.source,
    code: '',
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,

    helpers,
    vaporHelpers,
    helper(name: string) {
      helpers.add(name)
      return `_${name}`
    },
    vaporHelper(name: VaporHelper) {
      vaporHelpers.add(name)
      return `_${name}`
    },

    push(code, newlineIndex = NewlineType.None, loc, name) {
      context.code += code
      if (!__BROWSER__ && context.map) {
        if (loc) addMapping(loc.start, name)

        if (newlineIndex === NewlineType.Unknown) {
          // multiple newlines, full iteration
          advancePositionWithMutation(context, code)
        } else {
          // fast paths
          context.offset += code.length
          if (newlineIndex === NewlineType.None) {
            // no newlines; fast path to avoid newline detection
            if (__TEST__ && code.includes('\n')) {
              throw new Error(
                `CodegenContext.push() called newlineIndex: none, but contains` +
                  `newlines: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            context.column += code.length
          } else {
            // single newline at known index
            if (newlineIndex === NewlineType.End) {
              newlineIndex = code.length - 1
            }
            if (
              __TEST__ &&
              (code.charAt(newlineIndex) !== '\n' ||
                code.slice(0, newlineIndex).includes('\n') ||
                code.slice(newlineIndex + 1).includes('\n'))
            ) {
              throw new Error(
                `CodegenContext.push() called with newlineIndex: ${newlineIndex} ` +
                  `but does not conform: ${code.replace(/\n/g, '\\n')}`,
              )
            }
            context.line++
            context.column = code.length - newlineIndex
          }
        }
        if (loc && loc !== locStub) {
          addMapping(loc.end)
        }
      }
    },
    newline(code, newlineIndex, node) {
      context.push(`\n${`  `.repeat(context.indentLevel)}`, NewlineType.Start)
      code && context.push(code, newlineIndex, node)
    },
    pushMulti([left, right, seg], ...fns) {
      fns = fns.filter(Boolean)
      context.push(left)
      for (const [i, fn] of fns.entries()) {
        if (isString(fn)) context.push(fn)
        else (fn as () => void)()
        if (seg && i < fns.length - 1) context.push(seg)
      }
      context.push(right)
    },
    pushCall(name, ...args) {
      context.push(name)
      context.pushMulti(['(', ')', ', '], ...args)
    },
    withIndent(fn) {
      ++context.indentLevel
      fn()
      --context.indentLevel
    },
  }

  const filename = context.options.filename

  function addMapping(loc: Position, name: string | null = null) {
    // we use the private property to directly add the mapping
    // because the addMapping() implementation in source-map-js has a bunch of
    // unnecessary arg and validation checks that are pure overhead in our case.
    const { _names, _mappings } = context.map!
    if (name !== null && !_names.has(name)) _names.add(name)
    _mappings.add({
      originalLine: loc.line,
      originalColumn: loc.column - 1, // source-map column is 0 based
      generatedLine: context.line,
      generatedColumn: context.column - 1,
      source: filename,
      // @ts-expect-error it is possible to be null
      name,
    })
  }

  if (!__BROWSER__ && context.options.sourceMap) {
    // lazy require source-map implementation, only in non-browser builds
    context.map = new SourceMapGenerator()
    context.map.setSourceContent(filename, context.source)
    context.map._sources.add(filename)
  }

  return context
}

export interface VaporCodegenResult extends BaseCodegenResult {
  ast: RootIRNode
  helpers: Set<string>
  vaporHelpers: Set<string>
}

// IR -> JS codegen
export function generate(
  ir: RootIRNode,
  options: CodegenOptions = {},
): VaporCodegenResult {
  const ctx = createCodegenContext(ir, options)
  const { push, withIndent, newline, helpers, vaporHelper, vaporHelpers } = ctx

  const functionName = 'render'
  const isSetupInlined = !!options.inline
  if (isSetupInlined) {
    push(`(() => {`)
  } else {
    // placeholder for preamble
    newline()
    newline(`export function ${functionName}(_ctx) {`)
  }

  withIndent(() => {
    ir.template.forEach((template, i) => {
      if (template.type === IRNodeTypes.TEMPLATE_FACTORY) {
        // TODO source map?
        newline(
          `const t${i} = ${vaporHelper('template')}(${JSON.stringify(
            template.template,
          )})`,
        )
      } else {
        // fragment
        newline(`const t${i} = ${vaporHelper('fragment')}()`)
      }
    })

    genBlockFunctionContent(ir, ctx)
  })

  newline()
  if (isSetupInlined) {
    push('})()')
  } else {
    push('}')
  }

  let preamble = ''
  if (vaporHelpers.size)
    // TODO: extract import codegen
    preamble = `import { ${[...vaporHelpers]
      .map(h => `${h} as _${h}`)
      .join(', ')} } from 'vue/vapor';`
  if (helpers.size)
    preamble = `import { ${[...helpers]
      .map(h => `${h} as _${h}`)
      .join(', ')} } from 'vue';`

  if (!isSetupInlined) {
    ctx.code = preamble + ctx.code
  }

  return {
    code: ctx.code,
    ast: ir,
    preamble,
    map: ctx.map ? ctx.map.toJSON() : undefined,
    helpers,
    vaporHelpers,
  }
}

function genChildren(children: IRDynamicInfo[]) {
  let code = ''
  let offset = 0

  for (const [index, child] of children.entries()) {
    if (child.dynamicFlags & DynamicFlag.NON_TEMPLATE) {
      offset--
    }

    const idx = Number(index) + offset
    const id =
      child.dynamicFlags & DynamicFlag.REFERENCED
        ? child.dynamicFlags & DynamicFlag.INSERT
          ? child.anchor
          : child.id
        : null
    const childrenString = genChildren(child.children)

    if (id !== null || childrenString) {
      code += ` ${idx}: [`
      if (id !== null) code += `n${id}`
      if (childrenString) code += `, ${childrenString}`
      code += '],'
    }
  }

  if (!code) return ''
  return `{${code}}`
}

function genOperation(oper: OperationNode, context: CodegenContext) {
  // TODO: cache old value
  switch (oper.type) {
    case IRNodeTypes.SET_PROP:
      return genSetProp(oper, context)
    case IRNodeTypes.SET_TEXT:
      return genSetText(oper, context)
    case IRNodeTypes.SET_EVENT:
      return genSetEvent(oper, context)
    case IRNodeTypes.SET_HTML:
      return genSetHtml(oper, context)
    case IRNodeTypes.SET_REF:
      return genSetRef(oper, context)
    case IRNodeTypes.SET_MODEL_VALUE:
      return genSetModelValue(oper, context)
    case IRNodeTypes.CREATE_TEXT_NODE:
      return genCreateTextNode(oper, context)
    case IRNodeTypes.INSERT_NODE:
      return genInsertNode(oper, context)
    case IRNodeTypes.PREPEND_NODE:
      return genPrependNode(oper, context)
    case IRNodeTypes.APPEND_NODE:
      return genAppendNode(oper, context)
    case IRNodeTypes.IF:
      return genIf(oper, context)
    case IRNodeTypes.WITH_DIRECTIVE:
      // generated, skip
      return
    default:
      return checkNever(oper)
  }
}

export function genBlockFunctionContent(
  ir: BlockFunctionIRNode | RootIRNode,
  ctx: CodegenContext,
) {
  const { newline, withIndent, vaporHelper } = ctx
  newline(`const n${ir.dynamic.id} = t${ir.templateIndex}()`)

  const children = genChildren(ir.dynamic.children)
  if (children) {
    newline(`const ${children} = ${vaporHelper('children')}(n${ir.dynamic.id})`)
  }

  const directiveOps = ir.operation.filter(
    (oper): oper is WithDirectiveIRNode =>
      oper.type === IRNodeTypes.WITH_DIRECTIVE,
  )
  for (const directives of groupDirective(directiveOps)) {
    genWithDirective(directives, ctx)
  }

  for (const operation of ir.operation) {
    genOperation(operation, ctx)
  }

  for (const { operations } of ir.effect) {
    newline(`${vaporHelper('renderEffect')}(() => {`)
    withIndent(() => {
      for (const operation of operations) {
        genOperation(operation, ctx)
      }
    })
    newline('})')
  }

  newline(`return n${ir.dynamic.id}`)
}

function groupDirective(ops: WithDirectiveIRNode[]): WithDirectiveIRNode[][] {
  const directiveMap: Record<number, WithDirectiveIRNode[]> = {}
  for (const oper of ops) {
    if (!directiveMap[oper.element]) directiveMap[oper.element] = []
    directiveMap[oper.element].push(oper)
  }
  return Object.values(directiveMap)
}
