export { getPageContext }
export { getPageContextErrorPage }
export { checkIf404 }
export { isAlreadyServerSideRouted }

import { navigationState } from './navigationState.js'
import {
  assert,
  assertUsage,
  hasProp,
  objectAssign,
  getProjectError,
  serverSideRouteTo,
  executeHook,
  isObject,
  getGlobalObject
} from './utils.js'
import { parse } from '@brillout/json-serializer/parse'
import { getPageContextSerializedInHtml } from '../shared/getPageContextSerializedInHtml.js'
import type { PageContextExports, PageFile } from '../../shared/getPageFiles.js'
import { analyzePageServerSide } from '../../shared/getPageFiles/analyzePageServerSide.js'
import type { PageContextUrlComputedPropsInternal } from '../../shared/addUrlComputedProps.js'
import { PageContextForRoute, route } from '../../shared/route/index.js'
import { getErrorPageId } from '../../shared/error-page.js'
import { getHook } from '../../shared/hooks/getHook.js'
import { preparePageContextForUserConsumptionClientSide } from '../shared/preparePageContextForUserConsumptionClientSide.js'
import { loadPageFilesClientSide } from '../shared/loadPageFilesClientSide.js'
import { removeBuiltInOverrides } from './getPageContext/removeBuiltInOverrides.js'
import { getPageContextRequestUrl } from '../../shared/getPageContextRequestUrl.js'
import type { PageConfigRuntime } from '../../shared/page-configs/PageConfig.js'
import { getConfigValue, getPageConfig } from '../../shared/page-configs/helpers.js'
import { assertOnBeforeRenderHookReturn } from '../../shared/assertOnBeforeRenderHookReturn.js'
import { executeGuardHook } from '../../shared/route/executeGuardHook.js'
import type { PageContextForPassToClientWarning } from '../shared/getPageContextProxyForUser.js'
import { AbortRender, isAbortPageContext } from '../../shared/route/abort.js'
const globalObject = getGlobalObject<{ pageContextInitHasClientData?: true }>('router/getPageContext.ts', {})

type PageContextAddendum = {
  _pageId: string
  isHydration: boolean
  _pageFilesLoaded: PageFile[]
} & PageContextExports &
  PageContextForPassToClientWarning

type PageContextPassThrough = PageContextUrlComputedPropsInternal &
  PageContextForRoute & {
    isBackwardNavigation: boolean | null
  }

async function getPageContext(
  pageContext: {
    _pageId: string
    _isFirstRender: boolean
  } & PageContextPassThrough
): Promise<PageContextAddendum> {
  if (pageContext._isFirstRender && navigationState.isFirstUrl(pageContext.urlOriginal)) {
    const pageContextAddendum = await getPageContextFirstRender(pageContext)
    assert(pageContextAddendum._pageId === pageContext._pageId)
    setPageContextInitHasClientData(pageContextAddendum)
    return pageContextAddendum
  } else {
    const pageContextAddendum = await getPageContextUponNavigation(pageContext)
    setPageContextInitHasClientData(pageContextAddendum)
    return pageContextAddendum
  }
}

async function getPageContextFirstRender(
  pageContext: {
    _pageFilesAll: PageFile[]
    _pageConfigs: PageConfigRuntime[]
    urlOriginal: string
  } & PageContextPassThrough
): Promise<PageContextAddendum> {
  const pageContextAddendum = getPageContextSerializedInHtml()
  removeBuiltInOverrides(pageContextAddendum)

  objectAssign(pageContextAddendum, {
    isHydration: true,
    _hasPageContextFromClient: false
  })

  objectAssign(pageContextAddendum, await loadPageFilesClientSide(pageContextAddendum._pageId, pageContext))

  {
    const pageContextForHook = { ...pageContext, ...pageContextAddendum }
    if (await onBeforeRenderClientOnlyExists(pageContextForHook)) {
      const pageContextFromHook = await executeOnBeforeRenderHookClientSide(pageContextForHook)
      objectAssign(pageContextAddendum, pageContextFromHook)
    }
  }

  return pageContextAddendum
}

async function getPageContextErrorPage(
  pageContext: {
    urlOriginal: string
    _allPageIds: string[]
    _pageFilesAll: PageFile[]
    _pageConfigs: PageConfigRuntime[]
  } & PageContextPassThrough
): Promise<PageContextAddendum> {
  const errorPageId = getErrorPageId(pageContext._pageFilesAll, pageContext._pageConfigs)
  if (!errorPageId) throw new Error('No error page defined.')
  const pageContextAddendum = {
    isHydration: false,
    _pageId: errorPageId
  }
  objectAssign(pageContextAddendum, await getPageContextAlreadyRouted({ ...pageContext, ...pageContextAddendum }, true))
  return pageContextAddendum
}

async function getPageContextUponNavigation(pageContext: PageContextPassThrough): Promise<PageContextAddendum> {
  const pageContextAddendum = {
    isHydration: false
  }
  objectAssign(pageContextAddendum, await getPageContextFromRoute(pageContext))
  objectAssign(
    pageContextAddendum,
    await getPageContextAlreadyRouted({ ...pageContext, ...pageContextAddendum }, false)
  )
  return pageContextAddendum
}

async function getPageContextAlreadyRouted(
  pageContext: { _pageId: string; isHydration: boolean } & PageContextPassThrough,
  isErrorPage: boolean
): Promise<Omit<PageContextAddendum, '_pageId' | 'isHydration'>> {
  let pageContextAddendum = {}
  objectAssign(pageContextAddendum, await loadPageFilesClientSide(pageContext._pageId, pageContext))

  // Needs to be called before any client-side hook, because it may contain pageContextInit.user which is needed for guard() and onBeforeRender()
  if (
    // For the error page, we cannot fetch pageContext from the server because the pageContext JSON request is based on the URL
    !isErrorPage &&
    (await hasPageContextServer({ ...pageContext, ...pageContextAddendum }))
  ) {
    const pageContextFromServer = await fetchPageContextFromServer(pageContext)
    if (!pageContextFromServer['_isError']) {
      objectAssign(pageContextAddendum, pageContextFromServer)
    } else {
      const errorPageId = getErrorPageId(pageContext._pageFilesAll, pageContext._pageConfigs)
      assert(errorPageId)
      pageContextAddendum = {}
      objectAssign(pageContextAddendum, {
        isHydration: false,
        _pageId: errorPageId
      })

      objectAssign(pageContextAddendum, await loadPageFilesClientSide(pageContextAddendum._pageId, pageContext))

      assert(hasProp(pageContextFromServer, 'is404', 'boolean'))
      assert(hasProp(pageContextFromServer, 'pageProps', 'object'))
      assert(hasProp(pageContextFromServer.pageProps, 'is404', 'boolean'))
      // When the user hasn't define a `_error.page.js` file: the mechanism with `serverSideError: true` is used instead
      assert(!('serverSideError' in pageContextFromServer))
      objectAssign(pageContextAddendum, pageContextFromServer)
    }
  } else {
    objectAssign(pageContextAddendum, { _hasPageContextFromServer: false })
    // We don't need to call guard() on the client-side if we fetch pageContext from the server side. (Because the `${url}.pageContext.json` HTTP request will already trigger the routing and guard() hook on the serve-side.)
    // We cannot call guard() before retrieving pageContext from server, since the server-side may define pageContextInit.user which is paramount for guard() hooks
    if (!isErrorPage) {
      // Should we really call the guard() hook on the client-side? Shouldn't we make the guard() hook a server-side only hook? Or maybe make its env configurable like onBeforeRender()?
      await executeGuardHook(
        {
          _hasPageContextFromClient: false,
          ...pageContext,
          ...pageContextAddendum
        },
        (pageContext) => preparePageContextForUserConsumptionClientSide(pageContext, true)
      )
    }
  }

  {
    // For the error page, we also execute the client-side onBeforeRender() hook, but maybe we shouldn't? The server-side does it as well (but maybe it shouldn't).
    const pageContextFromHook = await executeOnBeforeRenderHookClientSide({ ...pageContext, ...pageContextAddendum })
    objectAssign(pageContextAddendum, pageContextFromHook)
  }

  return pageContextAddendum
}

async function executeOnBeforeRenderHookClientSide(
  pageContext: {
    _pageId: string
    urlOriginal: string
    isHydration: boolean
    _pageFilesAll: PageFile[]
    _pageConfigs: PageConfigRuntime[]
    _hasPageContextFromServer: boolean
  } & PageContextExports &
    PageContextPassThrough
) {
  const hook = getHook(pageContext, 'onBeforeRender')
  if (!hook) {
    const pageContextAddendum = {
      _hasPageContextFromClient: false
    }
    return pageContextAddendum
  }
  const onBeforeRender = hook.hookFn
  const pageContextAddendum = {
    _hasPageContextFromClient: true
  }
  const pageContextForUserConsumption = preparePageContextForUserConsumptionClientSide(
    {
      ...pageContext,
      ...pageContextAddendum
    },
    true
  )
  const hookResult = await executeHook(
    () => onBeforeRender(pageContextForUserConsumption),
    'onBeforeRender',
    hook.hookFilePath
  )
  assertOnBeforeRenderHookReturn(hookResult, hook.hookFilePath)
  const pageContextFromHook = hookResult?.pageContext
  objectAssign(pageContextAddendum, pageContextFromHook)
  return pageContextAddendum
}

async function hasPageContextServer(
  pageContext: Parameters<typeof onBeforeRenderServerOnlyExists>[0]
): Promise<boolean> {
  return !!globalObject.pageContextInitHasClientData || (await onBeforeRenderServerOnlyExists(pageContext))
}
// Workaround for the fact that the client-side cannot known whether a pageContext JSON request is needed in order to fetch pageContextInit data passed to the client.
//  - The workaround is reliable as long as the user sets additional pageContextInit to undefined instead of not defining the property:
//    ```diff
//    - // Breaks the workaround:
//    - const pageContextInit = { urlOriginal: req.url }
//    - if (user) pageContextInit.user = user
//    + // Makes the workaround reliable:
//    + const pageContextInit = { urlOriginal: req.url, user }
//    ```
// - We can show a warning to users when the pageContextInit keys aren't always the same. (We didn't implement the waning yet because it would require a new doc page https://vike.dev/pageContextInit#avoid-conditional-properties
// - Workaround cannot be made completely reliable because the workaround assumes that passToClient is always the same, but the user may set a different passToClient value for another page
// - Alternatively, we could define a new config `alwaysFetchPageContextFromServer: boolean`
function setPageContextInitHasClientData(pageContext: Record<string, unknown>) {
  if (pageContext._pageContextInitHasClientData) {
    globalObject.pageContextInitHasClientData = true
  }
}

async function onBeforeRenderServerOnlyExists(pageContext: {
  _pageId: string
  _pageFilesAll: PageFile[]
  _pageConfigs: PageConfigRuntime[]
}): Promise<boolean> {
  if (pageContext._pageConfigs.length > 0) {
    // V1
    const pageConfig = getPageConfig(pageContext._pageId, pageContext._pageConfigs)
    return getConfigValue(pageConfig, 'onBeforeRenderEnv')?.value === 'server-only'
  } else {
    // TODO/v1-release: remove
    // V0.4
    const { hasOnBeforeRenderServerSideOnlyHook } = await analyzePageServerSide(
      pageContext._pageFilesAll,
      pageContext._pageId
    )
    return hasOnBeforeRenderServerSideOnlyHook
  }
}
async function onBeforeRenderClientOnlyExists(pageContext: {
  _pageId: string
  _pageConfigs: PageConfigRuntime[]
}): Promise<boolean> {
  if (pageContext._pageConfigs.length > 0) {
    // V1
    const pageConfig = getPageConfig(pageContext._pageId, pageContext._pageConfigs)
    return getConfigValue(pageConfig, 'onBeforeRenderEnv')?.value === 'client-only'
  } else {
    // TODO/v1-release: remove
    return false
  }
}

async function getPageContextFromRoute(
  pageContext: PageContextForRoute
): Promise<{ _pageId: string; routeParams: Record<string, string> }> {
  const pageContextFromRoute = await route(pageContext)

  // We'll be able to remove this once async route functions are deprecated (because we'll be able to skip link hijacking if a link doesn't match a route (because whether to call event.preventDefault() needs to be determined synchronously))
  if (!pageContextFromRoute._pageId) {
    const err = new Error('No routing match')
    markIs404(err)
    throw err
  }

  assert(hasProp(pageContextFromRoute, '_pageId', 'string'))
  return pageContextFromRoute
}

function markIs404(err: Error) {
  objectAssign(err, { _is404: true })
}
function checkIf404(err: unknown): boolean {
  return isObject(err) && err._is404 === true
}

async function fetchPageContextFromServer(pageContext: { urlOriginal: string; _urlRewrite: string | null }) {
  const pageContextUrl = getPageContextRequestUrl(pageContext._urlRewrite ?? pageContext.urlOriginal)
  const response = await fetch(pageContextUrl)

  {
    const contentType = response.headers.get('content-type')
    const contentTypeCorrect = 'application/json'
    const isCorrect = contentType && contentType.includes(contentTypeCorrect)

    // Static hosts + page doesn't exist
    if (!isCorrect && response.status === 404) {
      serverSideRouteTo(pageContext.urlOriginal)
      throw AlreadyServerSideRouted()
    }

    assertUsage(
      isCorrect,
      `Wrong Content-Type for ${pageContextUrl}: it should be ${contentTypeCorrect} but it's ${contentType} instead. Make sure to properly use pageContext.httpResponse.headers, see https://vike.dev/renderPage`
    )
  }

  const responseText = await response.text()
  const pageContextFromServer: unknown = parse(responseText)
  assert(isObject(pageContextFromServer))

  if ('serverSideError' in pageContextFromServer) {
    throw getProjectError(
      `The pageContext object couldn't be fetched from the server as an error occurred on the server-side. Check your server logs.`
    )
  }

  if (isAbortPageContext(pageContextFromServer)) {
    throw AbortRender(pageContextFromServer)
  }

  assert(hasProp(pageContextFromServer, '_pageId', 'string'))
  removeBuiltInOverrides(pageContextFromServer)
  objectAssign(pageContextFromServer, { _hasPageContextFromServer: true })

  return pageContextFromServer
}

function isAlreadyServerSideRouted(err: unknown): boolean {
  return isObject(err) && !!err._alreadyServerSideRouted
}
function AlreadyServerSideRouted() {
  const err = new Error("Page doesn't exist")
  Object.assign(err, { _alreadyServerSideRouted: true })
  return err
}
