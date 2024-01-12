import lodashMerge from 'lodash-es/merge'
import { ref, unref, computed } from 'vue'

const DEBUG = true
const mappingProperty = '__ko_mapping__'
const realKoDependentObservable = computed
let mappingNesting = 0
let dependentObservables
let visitedObjects
const recognizedRootProperties = ['create', 'update', 'key', 'arrayChanged']
const emptyReturn = {}

const _originalDefaultOptions = {
  include: ['_destroy'],
  ignore: [],
  copy: [],
  observe: []
}
let _defaultOptions = _originalDefaultOptions

function unionArrays() {
  const args = arguments
  let l = args.length
  const obj = {}
  const res = []
  let i; let j; let k

  while (l--) {
    k = args[l]
    i = k.length

    while (i--) {
      j = k[i]
      if (!obj[j]) {
        obj[j] = 1
        res.push(j)
      }
    }
  }

  return res
}

function merge(obj1: any, obj2: any) {
  return lodashMerge({}, obj1, obj2)
}

export const isMapped = function(viewModel) {
  const unwrapped = ko.utils.unwrapObservable(viewModel)
  return unwrapped?.[mappingProperty]
}

export const fromJS = function(jsObject: Record<string, any>, options?: Record<string, any>, target?: Record<string, any>) {
  if (arguments.length === 0) throw new Error('When calling ko.fromJS, pass the object you want to convert.')

  try {
    if (!mappingNesting++) {
      dependentObservables = []
      visitedObjects = new objectLookup()
    }

    if (arguments.length === 2) {
      if (arguments[1][mappingProperty]) {
        target = arguments[1]
      } else {
        options = arguments[1]
      }
    }
    if (arguments.length === 3) {
      options = arguments[1]
      target = arguments[2]
    }

    if (target) {
      options = merge(options, target[mappingProperty])
    }
    options = fillOptions(options)

    let result = updateViewModel(target, jsObject, options)
    if (target) {
      result = target
    }

    // Evaluate any dependent observables that were proxied.
    // Do this after the model's observables have been created
    if (!--mappingNesting) {
      while (dependentObservables.length) {
        const DO = dependentObservables.pop()
        if (DO) {
          DO()

          // Move this magic property to the underlying dependent observable
          DO.__DO.throttleEvaluation = DO.throttleEvaluation
        }
      }
    }

    // Save any new mapping options in the view model, so that updateFromJS can use them later.
    result[mappingProperty] = merge(result[mappingProperty], options)

    return result
  } catch (e) {
    mappingNesting = 0
    throw e
  }
}

export const fromJSON = function(jsonString /*, options, target */) {
  const parsed = ko.utils.parseJson(jsonString)
  arguments[0] = parsed
  return fromJS.apply(this, arguments)
}

export const updateFromJS = function(viewModel) {
  throw new Error('ko.mapping.updateFromJS, use ko.mapping.fromJS instead. Please note that the order of parameters is different!')
}

export const updateFromJSON = function(viewModel) {
  throw new Error('ko.mapping.updateFromJSON, use ko.mapping.fromJSON instead. Please note that the order of parameters is different!')
}

export const toJS = function(rootObject, options) {
  if (!defaultOptions) resetDefaultOptions()

  if (arguments.length == 0) throw new Error('When calling ko.mapping.toJS, pass the object you want to convert.')
  if (getType(_defaultOptions.ignore) !== 'array') throw new Error('ko.mapping.defaultOptions().ignore should be an array.')
  if (getType(_defaultOptions.include) !== 'array') throw new Error('ko.mapping.defaultOptions().include should be an array.')
  if (getType(_defaultOptions.copy) !== 'array') throw new Error('ko.mapping.defaultOptions().copy should be an array.')

  // Merge in the options used in fromJS
  options = fillOptions(options, rootObject[mappingProperty])

  // We just unwrap everything at every level in the object graph
  return visitModel(rootObject, function(x) {
    return ko.utils.unwrapObservable(x)
  }, options)
}

export const toJSON = function(rootObject, options) {
  const plainJavaScriptObject = toJS(rootObject, options)
  return ko.utils.stringifyJson(plainJavaScriptObject)
}

export const defaultOptions = function() {
  if (arguments.length > 0) {
    _defaultOptions = arguments[0]
  } else {
    return _defaultOptions
  }
}

export const resetDefaultOptions = function() {
  _defaultOptions = {
    include: __defaultOptions.include.slice(0),
    ignore: __defaultOptions.ignore.slice(0),
    copy: __defaultOptions.copy.slice(0),
    observe: __defaultOptions.observe.slice(0)
  }
}

export const getType = function(x) {
  if ((x) && (typeof (x) === 'object')) {
    if (x.constructor === Date) return 'date'
    if (x.constructor === Array) return 'array'
  }
  return typeof x
}

function fillOptions(rawOptions, otherOptions) {
  const options = merge({}, rawOptions)

  // Move recognized root-level properties into a root namespace
  for (let i = recognizedRootProperties.length - 1; i >= 0; i--) {
    const property = recognizedRootProperties[i]

    // Carry on, unless this property is present
    if (!options[property]) continue

    // Move the property into the root namespace
    if (!(options[''] instanceof Object)) options[''] = {}
    options[''][property] = options[property]
    delete options[property]
  }

  if (otherOptions) {
    options.ignore = mergeArrays(otherOptions.ignore, options.ignore)
    options.include = mergeArrays(otherOptions.include, options.include)
    options.copy = mergeArrays(otherOptions.copy, options.copy)
    options.observe = mergeArrays(otherOptions.observe, options.observe)
  }
  options.ignore = mergeArrays(options.ignore, _defaultOptions.ignore)
  options.include = mergeArrays(options.include, _defaultOptions.include)
  options.copy = mergeArrays(options.copy, _defaultOptions.copy)
  options.observe = mergeArrays(options.observe, _defaultOptions.observe)

  options.mappedProperties = options.mappedProperties || {}
  options.copiedProperties = options.copiedProperties || {}
  return options
}

function mergeArrays(a, b) {
  if (getType(a) !== 'array') {
    if (getType(a) === 'undefined') a = []
    else a = [a]
  }
  if (getType(b) !== 'array') {
    if (getType(b) === 'undefined') b = []
    else b = [b]
  }

  return ko.utils.arrayGetDistinctValues(a.concat(b))
}

// When using a 'create' callback, we proxy the dependent observable so that it doesn't immediately evaluate on creation.
// The reason is that the dependent observables in the user-specified callback may contain references to properties that have not been mapped yet.
function withProxyDependentObservable(dependentObservables, callback) {
  const localDO = ko.dependentObservable
  ko.dependentObservable = function(read, owner, options) {
    options = options || {}

    if (read && typeof read === 'object') { // mirrors condition in knockout implementation of DO's
      options = read
    }

    const realDeferEvaluation = options.deferEvaluation

    let isRemoved = false

    // We wrap the original dependent observable so that we can remove it from the 'dependentObservables' list we need to evaluate after mapping has
    // completed if the user already evaluated the DO themselves in the meantime.
    const wrap = function(DO) {
      // Temporarily revert ko.dependentObservable, since it is used in ko.isWriteableObservable
      const tmp = computed
      ko.dependentObservable = realKoDependentObservable
      const isWriteable = ko.isWriteableObservable(DO)
      ko.dependentObservable = tmp

      const wrapped = realKoDependentObservable({
        read: function() {
          if (!isRemoved) {
            ko.utils.arrayRemoveItem(dependentObservables, DO)
            isRemoved = true
          }
          return DO.apply(DO, arguments)
        },
        write: isWriteable && function(val) {
          return DO(val)
        },
        deferEvaluation: true
      })
      if (DEBUG) wrapped.value._wrapper = true
      wrapped.value.__DO = DO
      return wrapped
    }

    options.deferEvaluation = true // will either set for just options, or both read/options.
    let realDependentObservable = new realKoDependentObservable(read, owner, options)

    if (!realDeferEvaluation) {
      realDependentObservable = wrap(realDependentObservable)
      dependentObservables.push(realDependentObservable)
    }

    return realDependentObservable
  }
  ko.dependentObservable.fn = realKoDependentObservable.fn
  ko.computed = ko.dependentObservable
  const result = callback()
  ko.dependentObservable = localDO
  ko.computed = ko.dependentObservable
  return result
}

function updateViewModel(mappedRootObject, rootObject, options, parentName, parent, parentPropertyName, mappedParent) {
  const isArray = getType(ko.utils.unwrapObservable(rootObject)) === 'array'

  parentPropertyName = parentPropertyName || ''

  // If this object was already mapped previously, take the options from there and merge them with our existing ones.
  if (isMapped(mappedRootObject)) {
    const previousMapping = ko.utils.unwrapObservable(mappedRootObject)[mappingProperty]
    options = merge(previousMapping, options)
  }

  const callbackParams = {
    data: rootObject,
    parent: mappedParent || parent
  }

  const hasCreateCallback = function() {
    return options[parentName] && options[parentName].create instanceof Function
  }

  const createCallback = function(data) {
    return withProxyDependentObservable(dependentObservables, function() {
      if (ko.utils.unwrapObservable(parent) instanceof Array) {
        return options[parentName].create({
          data: data || callbackParams.data,
          parent: callbackParams.parent,
          skip: emptyReturn
        })
      } else {
        return options[parentName].create({
          data: data || callbackParams.data,
          parent: callbackParams.parent
        })
      }
    })
  }

  const hasUpdateCallback = function() {
    return options[parentName] && options[parentName].update instanceof Function
  }

  const updateCallback = function(obj, data) {
    const params = {
      data: data || callbackParams.data,
      parent: callbackParams.parent,
      target: ko.utils.unwrapObservable(obj)
    }

    if (ko.isWriteableObservable(obj)) {
      params.observable = obj
    }

    return options[parentName].update(params)
  }

  const alreadyMapped = visitedObjects.get(rootObject)
  if (alreadyMapped) {
    return alreadyMapped
  }

  parentName = parentName || ''

  if (!isArray) {
    // For atomic types, do a direct update on the observable
    if (!canHaveProperties(rootObject)) {
      switch (getType(rootObject)) {
        case 'function':
          if (hasUpdateCallback()) {
            if (ko.isWriteableObservable(rootObject)) {
              rootObject(updateCallback(rootObject))
              mappedRootObject = rootObject
            } else {
              mappedRootObject = updateCallback(rootObject)
            }
          } else {
            mappedRootObject = rootObject
          }
          break
        default:
          if (ko.isWriteableObservable(mappedRootObject)) {
            if (hasUpdateCallback()) {
              var valueToWrite = updateCallback(mappedRootObject)
              mappedRootObject(valueToWrite)
              return valueToWrite
            } else {
              var valueToWrite = ko.utils.unwrapObservable(rootObject)
              mappedRootObject(valueToWrite)
              return valueToWrite
            }
          } else {
            const hasCreateOrUpdateCallback = hasCreateCallback() || hasUpdateCallback()

            if (hasCreateCallback()) {
              mappedRootObject = createCallback()
            } else {
              mappedRootObject = ko.observable(ko.utils.unwrapObservable(rootObject))
            }

            if (hasUpdateCallback()) {
              mappedRootObject(updateCallback(mappedRootObject))
            }

            if (hasCreateOrUpdateCallback) return mappedRootObject
          }
      }
    } else {
      mappedRootObject = ko.utils.unwrapObservable(mappedRootObject)
      if (!mappedRootObject) {
        if (hasCreateCallback()) {
          var result = createCallback()

          if (hasUpdateCallback()) {
            result = updateCallback(result)
          }

          return result
        } else {
          if (hasUpdateCallback()) {
            return updateCallback(result)
          }

          mappedRootObject = {}
        }
      }

      if (hasUpdateCallback()) {
        mappedRootObject = updateCallback(mappedRootObject)
      }

      visitedObjects.save(rootObject, mappedRootObject)
      if (hasUpdateCallback()) return mappedRootObject

      // For non-atomic types, visit all properties and update recursively
      visitPropertiesOrArrayEntries(rootObject, function(indexer) {
        const fullPropertyName = parentPropertyName.length ? parentPropertyName + '.' + indexer : indexer

        if (ko.utils.arrayIndexOf(options.ignore, fullPropertyName) != -1) {
          return
        }

        if (ko.utils.arrayIndexOf(options.copy, fullPropertyName) != -1) {
          mappedRootObject[indexer] = rootObject[indexer]
          return
        }

        if (typeof rootObject[indexer] !== 'object' && typeof rootObject[indexer] !== 'array' && options.observe.length > 0 && ko.utils.arrayIndexOf(options.observe, fullPropertyName) == -1) {
          mappedRootObject[indexer] = rootObject[indexer]
          options.copiedProperties[fullPropertyName] = true
          return
        }

        // In case we are adding an already mapped property, fill it with the previously mapped property value to prevent recursion.
        // If this is a property that was generated by fromJS, we should use the options specified there
        const prevMappedProperty = visitedObjects.get(rootObject[indexer])
        const retval = updateViewModel(mappedRootObject[indexer], rootObject[indexer], options, indexer, mappedRootObject, fullPropertyName, mappedRootObject)
        let value = prevMappedProperty || retval

        if (options.observe.length > 0 && ko.utils.arrayIndexOf(options.observe, fullPropertyName) == -1) {
          mappedRootObject[indexer] = ko.utils.unwrapObservable(value)
          options.copiedProperties[fullPropertyName] = true
          return
        }

        if (ko.isWriteableObservable(mappedRootObject[indexer])) {
          value = ko.utils.unwrapObservable(value)
          if (mappedRootObject[indexer]() !== value) {
            mappedRootObject[indexer](value)
          }
        } else {
          value = mappedRootObject[indexer] === undefined ? value : ko.utils.unwrapObservable(value)
          mappedRootObject[indexer] = value
        }

        options.mappedProperties[fullPropertyName] = true
      })
    }
  } else { // mappedRootObject is an array
    const changes = []

    let hasKeyCallback = false
    let keyCallback = function(x) {
      return x
    }
    if (options[parentName]?.key) {
      keyCallback = options[parentName].key
      hasKeyCallback = true
    }

    if (!ko.isObservable(mappedRootObject)) {
      // When creating the new observable array, also add a bunch of utility functions that take the 'key' of the array items into account.
      mappedRootObject = ko.observableArray([])

      mappedRootObject.mappedRemove = function(valueOrPredicate) {
        const predicate = typeof valueOrPredicate === 'function'
          ? valueOrPredicate
          : function(value) {
            return value === keyCallback(valueOrPredicate)
          }
        return mappedRootObject.remove(function(item) {
          return predicate(keyCallback(item))
        })
      }

      mappedRootObject.mappedRemoveAll = function(arrayOfValues) {
        const arrayOfKeys = filterArrayByKey(arrayOfValues, keyCallback)
        return mappedRootObject.remove(function(item) {
          return ko.utils.arrayIndexOf(arrayOfKeys, keyCallback(item)) != -1
        })
      }

      mappedRootObject.mappedDestroy = function(valueOrPredicate) {
        const predicate = typeof valueOrPredicate === 'function'
          ? valueOrPredicate
          : function(value) {
            return value === keyCallback(valueOrPredicate)
          }
        return mappedRootObject.destroy(function(item) {
          return predicate(keyCallback(item))
        })
      }

      mappedRootObject.mappedDestroyAll = function(arrayOfValues) {
        const arrayOfKeys = filterArrayByKey(arrayOfValues, keyCallback)
        return mappedRootObject.destroy(function(item) {
          return ko.utils.arrayIndexOf(arrayOfKeys, keyCallback(item)) != -1
        })
      }

      mappedRootObject.mappedIndexOf = function(item) {
        const keys = filterArrayByKey(mappedRootObject(), keyCallback)
        const key = keyCallback(item)
        return ko.utils.arrayIndexOf(keys, key)
      }

      mappedRootObject.mappedGet = function(item) {
        return mappedRootObject()[mappedRootObject.mappedIndexOf(item)]
      }

      mappedRootObject.mappedCreate = function(value) {
        if (mappedRootObject.mappedIndexOf(value) !== -1) {
          throw new Error('There already is an object with the key that you specified.')
        }

        let item = hasCreateCallback() ? createCallback(value) : value
        if (hasUpdateCallback()) {
          const newValue = updateCallback(item, value)
          if (ko.isWriteableObservable(item)) {
            item(newValue)
          } else {
            item = newValue
          }
        }
        mappedRootObject.push(item)
        return item
      }
    }

    const currentArrayKeys = filterArrayByKey(ko.utils.unwrapObservable(mappedRootObject), keyCallback).sort()
    const newArrayKeys = filterArrayByKey(rootObject, keyCallback)
    if (hasKeyCallback) newArrayKeys.sort()
    const editScript = ko.utils.compareArrays(currentArrayKeys, newArrayKeys)

    const ignoreIndexOf = {}

    let i, j

    const unwrappedRootObject = ko.utils.unwrapObservable(rootObject)
    const itemsByKey = {}
    let optimizedKeys = true
    for (i = 0, j = unwrappedRootObject.length; i < j; i++) {
      var key = keyCallback(unwrappedRootObject[i])
      if (key === undefined || key instanceof Object) {
        optimizedKeys = false
        break
      }
      itemsByKey[key] = unwrappedRootObject[i]
    }

    const newContents = []
    let passedOver = 0
    for (i = 0, j = editScript.length; i < j; i++) {
      var key = editScript[i]
      var mappedItem
      const fullPropertyName = parentPropertyName + '[' + i + ']'
      switch (key.status) {
        case 'added':
          var item = optimizedKeys ? itemsByKey[key.value] : getItemByKey(ko.utils.unwrapObservable(rootObject), key.value, keyCallback)
          mappedItem = updateViewModel(undefined, item, options, parentName, mappedRootObject, fullPropertyName, parent)
          if (!hasCreateCallback()) {
            mappedItem = ko.utils.unwrapObservable(mappedItem)
          }

          var index = ignorableIndexOf(ko.utils.unwrapObservable(rootObject), item, ignoreIndexOf)

          if (mappedItem === emptyReturn) {
            passedOver++
          } else {
            newContents[index - passedOver] = mappedItem
          }

          ignoreIndexOf[index] = true
          break
        case 'retained':
          var item = optimizedKeys ? itemsByKey[key.value] : getItemByKey(ko.utils.unwrapObservable(rootObject), key.value, keyCallback)
          mappedItem = getItemByKey(mappedRootObject, key.value, keyCallback)
          updateViewModel(mappedItem, item, options, parentName, mappedRootObject, fullPropertyName, parent)

          var index = ignorableIndexOf(ko.utils.unwrapObservable(rootObject), item, ignoreIndexOf)
          newContents[index] = mappedItem
          ignoreIndexOf[index] = true
          break
        case 'deleted':
          mappedItem = getItemByKey(mappedRootObject, key.value, keyCallback)
          break
      }

      changes.push({
        event: key.status,
        item: mappedItem
      })
    }

    mappedRootObject(newContents)

    if (options[parentName]?.arrayChanged) {
      ko.utils.arrayForEach(changes, function(change) {
        options[parentName].arrayChanged(change.event, change.item)
      })
    }
  }

  return mappedRootObject
}

function ignorableIndexOf(array, item, ignoreIndices) {
  for (let i = 0, j = array.length; i < j; i++) {
    if (ignoreIndices[i] === true) continue
    if (array[i] === item) return i
  }
  return null
}

function mapKey(item, callback) {
  let mappedItem
  if (callback) mappedItem = callback(item)
  if (getType(mappedItem) === 'undefined') mappedItem = item

  return ko.utils.unwrapObservable(mappedItem)
}

function getItemByKey(array, key, callback) {
  array = ko.utils.unwrapObservable(array)
  for (let i = 0, j = array.length; i < j; i++) {
    const item = array[i]
    if (mapKey(item, callback) === key) return item
  }

  throw new Error("When calling ko.update*, the key '" + key + "' was not found!")
}

function filterArrayByKey(array, callback) {
  return ko.utils.arrayMap(ko.utils.unwrapObservable(array), function(item) {
    if (callback) {
      return mapKey(item, callback)
    } else {
      return item
    }
  })
}

function visitPropertiesOrArrayEntries(rootObject, visitorCallback) {
  if (getType(rootObject) === 'array') {
    for (let i = 0; i < rootObject.length; i++) { visitorCallback(i) }
  } else {
    for (const propertyName in rootObject) { visitorCallback(propertyName) }
  }
};

function canHaveProperties(object) {
  const type = getType(object)
  return ((type === 'object') || (type === 'array')) && (object !== null)
}

// Based on the parentName, this creates a fully classified name of a property

function getPropertyName(parentName, parent, indexer) {
  let propertyName = parentName || ''
  if (getType(parent) === 'array') {
    if (parentName) {
      propertyName += '[' + indexer + ']'
    }
  } else {
    if (parentName) {
      propertyName += '.'
    }
    propertyName += indexer
  }
  return propertyName
}

export const visitModel = function(rootObject, callback, options) {
  options = options || {}
  options.visitedObjects = options.visitedObjects || new objectLookup()

  let mappedRootObject
  const unwrappedRootObject = ko.utils.unwrapObservable(rootObject)

  if (!canHaveProperties(unwrappedRootObject)) {
    return callback(rootObject, options.parentName)
  } else {
    options = fillOptions(options, unwrappedRootObject[mappingProperty])

    // Only do a callback, but ignore the results
    callback(rootObject, options.parentName)
    mappedRootObject = getType(unwrappedRootObject) === 'array' ? [] : {}
  }

  options.visitedObjects.save(rootObject, mappedRootObject)

  const parentName = options.parentName
  visitPropertiesOrArrayEntries(unwrappedRootObject, function(indexer) {
    if (options.ignore && ko.utils.arrayIndexOf(options.ignore, indexer) != -1) return

    const propertyValue = unwrappedRootObject[indexer]
    options.parentName = getPropertyName(parentName, unwrappedRootObject, indexer)

    // If we don't want to explicitly copy the unmapped property...
    if (ko.utils.arrayIndexOf(options.copy, indexer) === -1) {
      // ...find out if it's a property we want to explicitly include
      if (ko.utils.arrayIndexOf(options.include, indexer) === -1) {
        // The mapped properties object contains all the properties that were part of the original object.
        // If a property does not exist, and it is not because it is part of an array (e.g. "myProp[3]"), then it should not be unmapped.
				    if (unwrappedRootObject[mappingProperty]?.mappedProperties && !unwrappedRootObject[mappingProperty].mappedProperties[indexer]
				        && unwrappedRootObject[mappingProperty].copiedProperties && !unwrappedRootObject[mappingProperty].copiedProperties[indexer]
				        && !(getType(unwrappedRootObject) === 'array')) {
          return
        }
      }
    }

    let outputProperty
    switch (getType(ko.utils.unwrapObservable(propertyValue))) {
      case 'object':
      case 'array':
      case 'undefined':
        var previouslyMappedValue = options.visitedObjects.get(propertyValue)
        mappedRootObject[indexer] = (getType(previouslyMappedValue) !== 'undefined') ? previouslyMappedValue : visitModel(propertyValue, callback, options)
        break
      default:
        mappedRootObject[indexer] = callback(propertyValue, options.parentName)
    }
  })

  return mappedRootObject
}

function simpleObjectLookup() {
  const keys = []
  const values = []
  this.save = function(key, value) {
    const existingIndex = ko.utils.arrayIndexOf(keys, key)
    if (existingIndex >= 0) values[existingIndex] = value
    else {
      keys.push(key)
      values.push(value)
    }
  }
  this.get = function(key) {
    const existingIndex = ko.utils.arrayIndexOf(keys, key)
    const value = (existingIndex >= 0) ? values[existingIndex] : undefined
    return value
  }
};

function objectLookup() {
  const buckets = {}

  const findBucket = function(key) {
    let bucketKey
    try {
      bucketKey = key// JSON.stringify(key);
    } catch (e) {
      bucketKey = '$$$'
    }

    let bucket = buckets[bucketKey]
    if (bucket === undefined) {
      bucket = new simpleObjectLookup()
      buckets[bucketKey] = bucket
    }
    return bucket
  }

  this.save = function(key, value) {
    findBucket(key).save(key, value)
  }
  this.get = function(key) {
    return findBucket(key).get(key)
  }
};
