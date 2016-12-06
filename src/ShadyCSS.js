/**
@license
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/

'use strict';

import {parse} from './css-parse'
import {nativeShadow, nativeCssVariables, nativeCssApply} from './style-settings'
import {StyleTransformer} from './style-transformer'
import * as StyleUtil from './style-util'
import {StyleProperties} from './style-properties'
import templateMap from './template-map'
import placeholderMap from './style-placeholder'
import StyleInfo from './style-info'
import StyleCache from './style-cache'

// TODO(dfreedm): consider spliting into separate global
import ApplyShim from './apply-shim'
import {flush} from './document-watcher'

import assign from './object-assign'

let styleCache = new StyleCache();

export let ShadyCSS = {
  flush: flush,
  scopeCounter: {},
  nativeShadow: nativeShadow,
  nativeCss: nativeCssVariables,
  nativeCssApply: nativeCssApply,
  _documentOwner: document.documentElement,
  _documentOwnerStyleInfo: StyleInfo.set(document.documentElement, new StyleInfo({rules: []})),
  _generateScopeSelector(name) {
    let id = this.scopeCounter[name] = (this.scopeCounter[name] || 0) + 1;
    return name + '-' + id;
  },
  _forceRecalc: false,
  getStyleAst(style) {
    return StyleUtil.rulesForStyle(style);
  },
  styleAstToString(ast) {
    return StyleUtil.toCssText(ast);
  },
  _gatherStyles(template) {
    let styles = template.content.querySelectorAll('style');
    let cssText = [];
    for (let i = 0; i < styles.length; i++) {
      let s = styles[i];
      cssText.push(s.textContent);
      s.parentNode.removeChild(s);
    }
    return cssText.join('').trim();
  },
  _getCssBuild(template) {
    let style = template.content.querySelector('style');
    if (!style) {
      return '';
    }
    return style.getAttribute('css-build') || '';
  },
  prepareTemplate(template, elementName, typeExtension) {
    if (template._prepared) {
      return;
    }
    template._prepared = true;
    template.name = elementName;
    template.extends = typeExtension;
    templateMap[elementName] = template;
    let cssBuild = this._getCssBuild(template);
    let cssText = this._gatherStyles(template);
    let info = {
      is: elementName,
      extends: typeExtension,
      __cssBuild: cssBuild,
    };
    if (!this.nativeShadow) {
      StyleTransformer.dom(template.content, elementName);
    }
    let ast = parse(cssText);
    if (this.nativeCss && !this.nativeCssApply) {
      ApplyShim.transformRules(ast, elementName);
    }
    template._styleAst = ast;

    let ownPropertyNames = [];
    if (!this.nativeCss) {
      ownPropertyNames = StyleProperties.decorateStyles(template._styleAst, info);
    }
    if (!ownPropertyNames.length || this.nativeCss) {
      let root = this.nativeShadow ? template.content : null;
      let placeholder = placeholderMap[elementName];
      let style = this._generateStaticStyle(info, template._styleAst, root, placeholder);
      template._style = style;
    }
    template._ownPropertyNames = ownPropertyNames;
  },
  _generateStaticStyle(info, rules, shadowroot, placeholder) {
    let cssText = StyleTransformer.elementStyles(info, rules);
    if (cssText.length) {
      return StyleUtil.applyCss(cssText, info.is, shadowroot, placeholder);
    }
  },
  _prepareHost(host) {
    let is = host.getAttribute('is') || host.localName;
    let typeExtension;
    if (is !== host.localName) {
      typeExtension = host.localName;
    }
    let placeholder = placeholderMap[is];
    let template = templateMap[is];
    let ast;
    let ownStylePropertyNames;
    let cssBuild;
    if (template) {
      ast = template._styleAst;
      ownStylePropertyNames = template._ownPropertyNames;
      cssBuild = template._cssBuild;
    }
    return StyleInfo.set(host,
      new StyleInfo(
        ast,
        placeholder,
        ownStylePropertyNames,
        is,
        typeExtension,
        cssBuild
      )
    );
  },
  applyStyle(host, overrideProps) {
    let is = host.getAttribute('is') || host.localName;
    if (window.CustomStyle) {
      let CS = window.CustomStyle;
      if (CS._documentDirty) {
        CS.findStyles();
        if (!this.nativeCss) {
          this._updateProperties(this._documentOwner, this._documentOwnerStyleInfo);
        } else if (!this.nativeCssApply) {
          CS._revalidateApplyShim();
        }
        CS.applyStyles();
        CS._documentDirty = false;
      }
    }
    let styleInfo = StyleInfo.get(host);
    if (!styleInfo) {
      styleInfo = this._prepareHost(host);
    }
    if (overrideProps) {
      styleInfo.overrideStyleProperties =
        styleInfo.overrideStyleProperties || {};
      assign(styleInfo.overrideStyleProperties, overrideProps);
      this._forceRecalc = true;
    }
    let template = templateMap[is];
    if (this._forceRecalc || styleInfo.shouldRecalculate || template._applyShimInvalid) {
      if (this.nativeCss) {
        if (template && template._style && template._applyShimInvalid) {
          // update template
          if (!template._invalidating) {
            ApplyShim.transformRules(template._styleAst, is);
            template._style.textContent = StyleTransformer.elementStyles(host, styleInfo.styleRules);
            StyleInfo.validate(is);
          }
          // update instance if native shadowdom
          if (this.nativeShadow) {
            let root = host.shadowRoot;
            if (root) {
              let style = root.querySelector('style');
              style.textContent = StyleTransformer.elementStyles(host, styleInfo.styleRules);
            }
          }
          styleInfo.styleRules = template._styleAst;
        }
        this._updateNativeProperties(host, styleInfo.overrideStyleProperties);
      } else {
        this._updateProperties(host, styleInfo);
        if (styleInfo.ownStylePropertyNames && styleInfo.ownStylePropertyNames.length) {
          this._applyStyleProperties(host, styleInfo);
        }
      }
    }
    styleInfo.shouldRecalculate = false;
    let root = this._isRootOwner(host) ? host : host.shadowRoot;
    // note: some elements may not have a root!
    if (root) {
      this._applyToDescendants(root.children);
    }
    this._forceRecalc = false;
  },
  applyStyleInvalid(node) {
    let styleInfo = StyleInfo.get(node);
    if (styleInfo) {
      styleInfo.shouldRecalculate = true;
    }
  },
  _isElementNode(node) {
    return node.nodeType === Node.ELEMENT_NODE;
  },
  _applyToDescendants(children) {
    for (let i = 0, c; i < children.length; i++) {
      c = children[i];
      if (c.shadowRoot) {
        this.applyStyle(c);
      } else if (nativeCssVariables && c.localName === 'slot') {
        // TODO(dfreedm): remove when ShadyDOM flushes assignedNodes
        if (!nativeShadow) {
          window.ShadyDOM.flush();
        }
        // Also apply styles to elements that have been composed through a `slot`
        this._applyToDescendants(c.assignedNodes().filter(this._isElementNode));
      }
      this._applyToDescendants(c.children);
    }
  },
  _styleOwnerForNode(node) {
    let root = node.getRootNode();
    let host = root.host;
    if (host) {
      if (StyleInfo.get(host)) {
        return host;
      } else {
        return this._styleOwnerForNode(host);
      }
    }
    return this._documentOwner;
  },
  _isRootOwner(node) {
    return (node === this._documentOwner);
  },
  _applyStyleProperties(host, styleInfo) {
    let is = host.getAttribute('is') || host.localName;
    let cacheEntry = styleCache.fetch(is, styleInfo.styleProperties, styleInfo.ownStylePropertyNames);
    let cachedScopeSelector = cacheEntry && cacheEntry.scopeSelector;
    let cachedStyle = cacheEntry ? cacheEntry.styleElement : null;
    let oldScopeSelector = styleInfo.scopeSelector;
    // only generate new scope if cached style is not found
    styleInfo.scopeSelector = cachedScopeSelector || this._generateScopeSelector(is);
    let style = StyleProperties.applyElementStyle(host, styleInfo.styleProperties, styleInfo.scopeSelector, cachedStyle);
    if (!this.nativeShadow) {
      StyleProperties.applyElementScopeSelector(host, styleInfo.scopeSelector, oldScopeSelector);
    }
    if (!cacheEntry) {
      styleCache.store(is, styleInfo.styleProperties, style, styleInfo.scopeSelector);
    }
    return style;
  },
  _updateProperties(host, styleInfo) {
    let owner = this._styleOwnerForNode(host);
    let ownerStyleInfo = StyleInfo.get(owner);
    let ownerProperties = ownerStyleInfo.styleProperties;
    let props = Object.create(ownerProperties || null);
    let hostAndRootProps = StyleProperties.hostAndRootPropertiesForScope(host, styleInfo.styleRules);
    let propertyData = StyleProperties.propertyDataFromStyles(ownerStyleInfo.styleRules, host);
    let propertiesMatchingHost = propertyData.properties
    assign(
      props,
      hostAndRootProps.hostProps,
      propertiesMatchingHost,
      hostAndRootProps.rootProps
    );
    this._mixinOverrideStyles(props, styleInfo.overrideStyleProperties);
    StyleProperties.reify(props);
    styleInfo.styleProperties = props;
  },
  _mixinOverrideStyles(props, overrides) {
    for (let p in overrides) {
      let v = overrides[p];
      // skip override props if they are not truthy or 0
      // in order to fall back to inherited values
      if (v || v === 0) {
        props[p] = v;
      }
    }
  },
  _updateNativeProperties(element, properties) {
    // remove previous properties
    for (let p in properties) {
      // NOTE: for bc with shim, don't apply null values.
      if (p === null) {
        element.style.removeProperty(p);
      } else {
        element.style.setProperty(p, properties[p]);
      }
    }
  },
  updateStyles(properties) {
    if (window.CustomStyle) {
      window.CustomStyle._documentDirty = true;
    }
    this.applyStyle(this._documentOwner, properties);
  },
  /* Custom Style operations */
  _transformCustomStyleForDocument(style) {
    let ast = StyleUtil.rulesForStyle(style);
    StyleUtil.forEachRule(ast, (rule) => {
      if (nativeShadow) {
        StyleTransformer.normalizeRootSelector(rule);
      } else {
        StyleTransformer.documentRule(rule);
      }
      if (this.nativeCss && !this.nativeCssApply) {
        ApplyShim.transformRule(rule);
      }
    });
    if (this.nativeCss) {
      style.textContent = StyleUtil.toCssText(ast);
    } else {
      this._documentOwnerStyleInfo.styleRules.rules.push(ast);
    }
  },
  _revalidateApplyShim(style) {
    if (this.nativeCss && !this.nativeCssApply) {
      let ast = StyleUtil.rulesForStyle(style);
      ApplyShim.transformRules(ast);
      style.textContent = StyleUtil.toCssText(ast);
    }
  },
  _applyCustomStyleToDocument(style) {
    if (!this.nativeCss) {
      StyleProperties.applyCustomStyle(style, this._documentOwnerStyleInfo.styleProperties);
    }
  },
  getComputedStyleValue(element, property) {
    let value;
    if (!this.nativeCss) {
      // element is either a style host, or an ancestor of a style host
      let styleInfo = StyleInfo.get(element) || StyleInfo.get(this._styleOwnerForNode(element));
      value = styleInfo.styleProperties[property];
    }
    // fall back to the property value from the computed styling
    value = value || window.getComputedStyle(element).getPropertyValue(property);
    // trim whitespace that can come after the `:` in css
    // example: padding: 2px -> " 2px"
    return value.trim();
  },
  // given an element and a classString, replaces
  // the element's class with the provided classString and adds
  // any necessary ShadyCSS static and property based scoping selectors
  setElementClass(element, classString) {
    let root = element.getRootNode();
    let classes = classString ? classString.split(/\s/) : [];
    let scopeName = root.host && root.host.localName;
    // If no scope, try to discover scope name from existing class.
    // This can occur if, for example, a template stamped element that
    // has been scoped is manipulated when not in a root.
    if (!scopeName) {
      var classAttr = element.getAttribute('class');
      if (classAttr) {
        let k$ = classAttr.split(/\s/);
        for (let i=0; i < k$.length; i++) {
          if (k$[i] === StyleTransformer.SCOPE_NAME) {
            scopeName = k$[i+1];
            break;
          }
        }
      }
    }
    if (scopeName) {
      classes.push(StyleTransformer.SCOPE_NAME, scopeName);
    }
    if (!this.nativeCss) {
      let styleInfo = StyleInfo.get(element);
      if (styleInfo && styleInfo.scopeSelector) {
        classes.push(StyleProperties.XSCOPE_NAME, styleInfo.scopeSelector);
      }
    }
    StyleUtil.setElementClassRaw(element, classes.join(' '));
  },
  _styleInfoForNode(node) {
    return StyleInfo.get(node);
  }
}

window['ShadyCSS'] = ShadyCSS;
