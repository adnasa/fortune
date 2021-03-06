'use strict'

var validateRecords = require('./validate_records')
var checkLinks = require('./check_links')
var enforce = require('../record_type/enforce')
var message = require('../common/message')
var promise = require('../common/promise')
var map = require('../common/array/map')

var errors = require('../common/errors')
var BadRequestError = errors.BadRequestError

var updateHelpers = require('./update_helpers')
var getUpdate = updateHelpers.getUpdate
var addId = updateHelpers.addId

var constants = require('../common/constants')
var changeEvent = constants.change
var createMethod = constants.create
var updateMethod = constants.update
var primaryKey = constants.primary
var linkKey = constants.link
var inverseKey = constants.inverse
var isArrayKey = constants.isArray
var denormalizedInverseKey = constants.denormalizedInverse


/**
 * Extend context so that it includes the parsed records and create them.
 * This mutates the response object.
 *
 * @return {Promise}
 */
module.exports = function (context) {
  var self = this
  var Promise = promise.Promise
  var adapter = self.adapter
  var recordTypes = self.recordTypes
  var transforms = self.transforms
  var updates = {}
  var links = []
  var transaction, records, type, meta, transform, fields, language

  // Start a promise chain.
  return Promise.resolve(context.request.payload)

  .then(function (payload) {
    var i, field

    records = payload

    if (!records || !records.length)
      throw new BadRequestError(message('CreateRecordsInvalid', language))

    type = context.request.type
    meta = context.request.meta
    language = meta.language

    transform = transforms[type]
    fields = recordTypes[type]

    for (field in fields) {
      if (linkKey in fields[field])
        links.push(field)

      // Delete denormalized inverse fields.
      if (denormalizedInverseKey in fields[field])
        for (i = records.length; i--;) delete records[i][field]
    }

    return adapter.beginTransaction()
  })

  .then(function (result) {
    context.transaction = transaction = result

    return typeof transform[0] === 'function' ?
      Promise.all(map(records, function (record) {
        return transform[0](context, record)
      })) : records
  })

  .then(function (results) {
    records = results

    return Promise.all(map(records, function (record) {
      // Enforce the fields.
      enforce(type, record, fields, meta)

      // Ensure referential integrity.
      return checkLinks.call(self, record, fields, links, meta)
      .then(function () { return record })
    }))
  })

  .then(function (records) {
    validateRecords.call(self, records, fields, links, meta)
    return transaction.create(type, records, meta)
  })

  .then(function (createdRecords) {
    var i, j, k, record, field, inverseField,
      linkedType, linkedIsArray, linkedIds, id

    // Update inversely linked records on created records.
    // Trying to batch updates to be as few as possible.
    var idCache = {}

    records = createdRecords

    Object.defineProperty(context.response, 'records', {
      configurable: true,
      value: records
    })

    // Adapter must return something.
    if (!records.length)
      throw new BadRequestError(message('CreateRecordsFail', language))

    // Iterate over each record to generate updates object.
    for (i = records.length; i--;) {
      record = records[i]

      // Each created record must have an ID.
      if (!(primaryKey in record))
        throw new Error(message('CreateRecordMissingID', language))

      for (j = links.length; j--;) {
        field = links[j]
        inverseField = fields[field][inverseKey]

        if (!(field in record) || !inverseField) continue

        linkedType = fields[field][linkKey]
        linkedIsArray =
          recordTypes[linkedType][inverseField][isArrayKey]
        linkedIds = Array.isArray(record[field]) ?
          record[field] : [ record[field] ]

        // Do some initialization.
        if (!updates[linkedType]) updates[linkedType] = []
        if (!idCache[linkedType]) idCache[linkedType] = {}

        for (k = linkedIds.length; k--;) {
          id = linkedIds[k]
          if (id !== null)
            addId(record[primaryKey],
              getUpdate(linkedType, id, updates, idCache),
              inverseField, linkedIsArray)
        }
      }
    }

    return Promise.all(map(Object.keys(updates), function (type) {
      return updates[type].length ?
        transaction.update(type, updates[type], meta) :
        null
    }))
  })

  .then(function () {
    return transaction.endTransaction()
  })

  // This makes sure to call `endTransaction` before re-throwing the error.
  .catch(function (error) {
    if (transaction) transaction.endTransaction(error)
    throw error
  })

  .then(function () {
    var eventData = {}, currentType

    eventData[createMethod] = {}
    eventData[createMethod][type] = records

    for (currentType in updates) {
      if (!updates[currentType].length) continue
      if (!(updateMethod in eventData)) eventData[updateMethod] = {}
      eventData[updateMethod][currentType] = updates[currentType]
    }

    // Summarize changes during the lifecycle of the request.
    self.emit(changeEvent, eventData)

    return context
  })
}
