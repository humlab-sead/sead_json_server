const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
//const GeneralEndpoints = require('./ApiEndpoints/GeneralEndpoints.class')
const DendrochronologyModule = require('./Modules/DendrochronologyModule.class');
const AbundanceModule = require('./Modules/AbundanceModule.class');
const MeasuredValuesModule = require('./Modules/MeasuredValuesModule.class');

class SeadDataServer {
    constructor() {
        this.useSiteCaching = false;
        this.useStaticDbConnection = true;
        this.staticDbConnection = null;
        console.log("Starting up SEAD Data Server");
        this.expressApp = express();
        this.expressApp.use(cors());
        this.expressApp.use(bodyParser.json());
        this.setupDatabase().then(() => {
            this.setupEndpoints();
            //this.generalEndpoints = new GeneralEndpoints(this);

            this.modules = [];
            this.modules.push(new AbundanceModule(this));
            this.modules.push(new DendrochronologyModule(this));
            this.modules.push(new MeasuredValuesModule(this));

            //this.abundance = new AbundanceModule(this);
            //this.dendro = new DendrochronologyModule(this);
            this.run();
        });
    }

    setupEndpoints() {
        this.expressApp.get('/site/:siteId', async (req, res) => {
            let site = await this.getSite(req.params.siteId, true);
            res.send(JSON.stringify(site, null, 2));
        });

        this.expressApp.get('/sample/:sampleId', async (req, res) => {
            console.log(req.path);
            try {
                const pgClient = await this.getDbConnection();
                let data = await pgClient.query('SELECT * FROM tbl_analysis_entities WHERE physical_sample_id=$1', [req.params.sampleId]);
                let datasets = this.groupAnalysisEntitiesByDataset(data.rows);
                return res.send(JSON.stringify(datasets));
            }
            catch(error) {
                console.error("Couldn't connect to database");
                console.error(error);
                return res.send(JSON.stringify({
                    error: "Internal server error"
                }));
            }
        });

        this.expressApp.get('/preload', async (req, res) => {
            console.log(req.path);
            await this.preloadAllSites();
            res.send("Preload complete");
        });

        /*
        this.expressApp.get('/site/:siteId', async (req, res) => {
            console.log(req.path);
            const pgClient = await this.pgPool.connect();
            //Returns general metadata about the site - but NOT the samples or analyses
            await pgClient.query('SELECT * FROM tbl_sites WHERE site_id=$1', [req.params.siteId]).then((data) => {
                pgClient.release();
                return res.send(data);
            });
        });
        */

        this.expressApp.get('/dataset/:datasetId', async (req, res) => {
            let dataset = {
                dataset_id: req.params.datasetId
            };
        
            let data = await query('SELECT * FROM tbl_datasets WHERE dataset_id=$1', [req.params.datasetId]);
            dataset = data.rows[0];
        
            let method = await query('SELECT * FROM tbl_methods WHERE method_id=$1', [data.rows[0].method_id]);
            dataset.method = method.rows[0];
        
            let ae = await query('SELECT * FROM tbl_analysis_entities WHERE dataset_id=$1', [dataset.dataset_id]);
            dataset.analysis_entities = ae.rows;
            
        
            if(dataset.biblio_id != null) {
                dataset.biblio = await fetchBiblioByDatasetId(dataset.dataset_id);
            }
        
            //If dataset belongs to certain methods, it might include dating data, so fetch it
            if(datingMethodGroups.includes(dataset.method.method_group_id)) {
                if(dataset.analysis_entities.length > 0) {
                    await fetchDatingToPeriodData(dataset.analysis_entities);
                }
            }
            
            await fetchPhysicalSamplesByAnalysisEntities(dataset.analysis_entities);
        
            res.send(dataset);
        });
    }

    async preloadAllSites() {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        console.time("Preload of sites complete");

        console.log("Preloading sites");

        let siteData = await pgClient.query('SELECT * FROM tbl_sites ORDER BY site_id');
        this.releaseDbConnection(pgClient);

        console.log("Will fetch site data for "+siteData.rows.length+" sites");

        let siteIds = [];
        for(let key in siteData.rows) {
            siteIds.push(siteData.rows[key].site_id);
        }

        let maxConcurrentFetches = 5;
        let pendingFetches = 0;
        
        const fetchCheckInterval = setInterval(() => {
            if(siteIds.length > 0 && pendingFetches < maxConcurrentFetches) {
                pendingFetches++;
                let siteId = siteIds.shift();
                console.time("Site "+siteId+" fetched");
                console.log("Fetching site", siteId);
                this.getSite(siteId, false).then(() => {
                    console.timeEnd("Site "+siteId+" fetched");
                    pendingFetches--;
                })
            }
            if(siteIds.length == 0) {
                clearInterval(fetchCheckInterval);
                console.timeEnd("Preload of sites complete");
            }
        }, 100)

        /*
        for(let key in siteData.rows) {
            let siteId = siteData.rows[key].site_id;
            console.time("Site "+siteId+" fetched");
            console.log("Fetching site", siteId);
            await this.getSite(siteId, false);
            console.timeEnd("Site "+siteId+" fetched");
        }
        */

        /*
        siteData.rows.forEach(async siteRow => {
            console.time("Site "+siteRow.site_id+" fetched");
            console.log("Fetching site", siteRow.site_id);
            let promise = await this.getSite(siteRow.site_id, false).then(() => {
                console.timeEnd("Site "+siteRow.site_id+" fetched");
            });

            queryPromises.push(promise);
        })
        */

        //await Promise.all(queryPromises);

        //console.timeEnd("Preload of sites complete");
    }

    async getSite(siteId, verbose = true, fetchMethodSpecificData = true) {
        if(verbose) console.log("Request for site", siteId);
        let site = null;
        if(this.useSiteCaching) {
            site = this.getSiteFromCache(siteId);
            if(site) {
                return site;
            }
        }

        if(verbose) console.time("Done fetching site");

        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        if(verbose) console.time("Fetched basic site data");
        let siteData = await pgClient.query('SELECT * FROM tbl_sites WHERE site_id=$1', [siteId]);
        if(verbose) console.timeEnd("Fetched basic site data");

        site = siteData.rows[0];

        //fetch sample groups
        if(verbose) console.time("Fetched sample groups");
        site.sample_groups = [];
        let sampleGroups = await pgClient.query('SELECT * FROM tbl_sample_groups WHERE site_id=$1', [siteId]);
        site.sample_groups = sampleGroups.rows;
        if(verbose) console.timeEnd("Fetched sample groups");
        this.releaseDbConnection(pgClient);
        

        if(verbose) console.time("Fetched sample group descriptions");
        await this.fetchSampleGroupDescriptions(site);
        if(verbose) console.timeEnd("Fetched sample group descriptions");

        if(verbose) console.time("Fetched sample groups methods");
        await this.fetchMethodsFromSampleGroups(site);
        if(verbose) console.timeEnd("Fetched sample groups methods");
        
        if(verbose) console.time("Fetched physical samples");
        await this.fetchPhysicalSamples(site);
        if(verbose) console.timeEnd("Fetched physical samples");

        if(verbose) console.time("Fetched analysis entities");
        await this.fetchAnalysisEntities(site);
        if(verbose) console.timeEnd("Fetched analysis entities");

        if(verbose) console.time("Fetched feature types");
        await this.fetchFeatureTypes(site);
        if(verbose) console.timeEnd("Fetched feature types");

        
        console.time("Fetched datasets");
        await this.fetchDatasets(site);
        console.timeEnd("Fetched datasets");
        
        
        if(verbose) console.time("Fetched analysis methods");
        await this.fetchAnalysisMethods(site);
        if(verbose) console.timeEnd("Fetched analysis methods");

        if(fetchMethodSpecificData) {
            if(verbose) console.time("Fetched method specific data");
            await this.fetchMethodSpecificData(site);
            if(verbose) console.timeEnd("Fetched method specific data");
        }
        
        if(verbose) console.timeEnd("Done fetching site");

        if(this.useSiteCaching) {
            //Store in cache
            this.saveSiteToCache(site);
        }

        return site;
    }

    async fetchMethodSpecificData(site, verbose = true) {
        let fetchPromises = [];
        
        for(let key in this.modules) {
            let module = this.modules[key];
            if(verbose) console.time("Fetched method "+module.name);
            let promise = module.fetchSiteData(site);
            fetchPromises.push(promise);
            promise.then(() => {
                if(verbose) console.timeEnd("Fetched method "+module.name);
            });
        }

        return Promise.all(fetchPromises);
    }

    async fetchAnalysisMethods(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        let methodIds = [];
        site.datasets.forEach(dataset => {
            if(methodIds.indexOf(dataset.method_id) == -1) {
                methodIds.push(dataset.method_id);
            }
        });

        let queryPromises = [];
        let methods = [];
        methodIds.forEach(methodId => {
            let promise = pgClient.query('SELECT * FROM tbl_methods WHERE method_id=$1', [methodId]).then(method => {
                methods.push(method.rows[0]);
            });
            queryPromises.push(promise);
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });
        
        site.analysisMethods = methods;

        return site;
    }

    async fetchDatasets(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        //Get the unqiue dataset_ids
        let datasetIds = [];
        site.sample_groups.forEach(sampleGroup => {
            sampleGroup.physical_samples.forEach(physicalSample => {
                physicalSample.analysis_entities.forEach(analysisEntity => {
                    if(datasetIds.indexOf(analysisEntity.dataset_id) == -1) {
                        datasetIds.push(analysisEntity.dataset_id);
                    }
                })
            })
        });

        let queryPromises = [];
        let datasets = [];
        datasetIds.forEach(datasetId => {
            let promise = pgClient.query('SELECT * FROM tbl_datasets WHERE dataset_id=$1', [datasetId]).then(dataset => {
                datasets.push(dataset.rows[0]);
            });
            queryPromises.push(promise);
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });
        
        site.datasets = datasets;

        return site;
    }

    async fetchMethodsFromSampleGroups(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        let queryPromises = [];
        site.sample_groups.forEach(sampleGroup => {
            
            let promise = pgClient.query('SELECT * FROM tbl_methods WHERE method_id=$1', [sampleGroup.method_id]).then(method => {
                sampleGroup.method = method.rows[0];
            });
            queryPromises.push(promise);
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });

        return site;
    }

    async fetchFeatureTypes(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        /*
        qse_sample_features is a view and this is the definition:

        SELECT
        tbl_physical_sample_features.physical_sample_id,
        tbl_feature_types.feature_type_id,
        tbl_feature_types.feature_type_name,
        tbl_feature_types.feature_type_description,
        tbl_features.feature_id,
        tbl_features.feature_name,
        tbl_features.feature_description
        FROM
        tbl_physical_sample_features
        INNER JOIN tbl_features ON tbl_physical_sample_features.feature_id = tbl_features.feature_id
        INNER JOIN tbl_feature_types ON tbl_features.feature_type_id = tbl_feature_types.feature_type_id
        */

        let queryPromises = [];
        site.sample_groups.forEach(sampleGroup => {
            sampleGroup.physical_samples.forEach(physicalSample => {
                let promise = pgClient.query('SELECT * FROM postgrest_api.qse_sample_features WHERE physical_sample_id=$1', [physicalSample.physical_sample_id]).then(sampleFeatures => {
                    physicalSample.features = sampleFeatures.rows;
                });
                queryPromises.push(promise);
            });
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });

        return site;
    }

    async fetchAnalysisEntities(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        let queryPromises = [];
        site.sample_groups.forEach(sampleGroup => {
            sampleGroup.physical_samples.forEach(physicalSample => {
                let promise = pgClient.query('SELECT * FROM tbl_analysis_entities WHERE physical_sample_id=$1', [physicalSample.physical_sample_id]).then(analysisEntities => {
                    physicalSample.analysis_entities = analysisEntities.rows;
                });
                queryPromises.push(promise);
            });
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });

        return site;
    }

    async fetchPhysicalSamples(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        let queryPromises = [];
        site.sample_groups.forEach(sampleGroup => {
            let promise = pgClient.query('SELECT * FROM tbl_physical_samples WHERE sample_group_id=$1', [sampleGroup.sample_group_id]).then(physicalSamples => {
                sampleGroup.physical_samples = physicalSamples.rows;
            });

            queryPromises.push(promise);
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });

        return site;
    }

    async fetchSampleGroupDescriptions(site) {
        let pgClient = await this.getDbConnection();
        if(!pgClient) {
            return false;
        }

        let queryPromises = [];
        site.sample_groups.forEach(sampleGroup => {
            let promise = pgClient.query('SELECT * FROM tbl_sample_group_descriptions WHERE sample_group_id=$1', [sampleGroup.sample_group_id]).then(sampleGroupDescriptions => {
                sampleGroup.descriptions = sampleGroupDescriptions.rows;
            });

            queryPromises.push(promise);
        });

        await Promise.all(queryPromises).then(() => {
            this.releaseDbConnection(pgClient);
        });

        return site;
    }

    getSiteFromCache(siteId) {
        let result = false;
        try {
            result = fs.readFileSync("site_cache/site_"+siteId+".json");
        }
        catch(error) {
            return false;
        }
        if(result) {
            return JSON.parse(result);
        }
        return false;
    }

    async saveSiteToCache(site) {
        return fs.writeFileSync("site_cache/site_"+site.site_id+".json", JSON.stringify(site, null, 2));
    }


    groupAnalysisEntitiesByDataset(analysisEntities) {
        let datasets = [];

        let datasetsIds = analysisEntities.map((ae) => {
            return ae.dataset_id;
        });

        datasetsIds = datasetsIds.filter((value, index, self) => {
            return self.indexOf(value) === index;
        });

        datasetsIds.forEach((datasetId) => {
            datasets.push({
                datasetId: datasetId,
                analysisEntities: []
            });
        })

        for(let key in analysisEntities) {

            for(let dsKey in datasets) {
                if(analysisEntities[key].dataset_id == datasets[dsKey].datasetId) {
                    datasets[dsKey].analysisEntities.push(analysisEntities[key]);
                }
            }
        }

        return datasets;
    }

    async setupDatabase() {
        try {
            this.pgPool = new Pool({
                user: process.env.POSTGRES_USER,
                host: process.env.POSTGRES_HOST,
                database: process.env.POSTGRES_DATABASE,
                password:process.env.POSTGRES_PASS,
                port: process.env.POSTGRES_PORT,
                max: 50,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 30000,
            });

            if(this.useStaticDbConnection) {
                console.log("Setting up static db connection");
                this.staticDbConnection = await this.pgPool.connect();
                console.log("Database ready");
            }

            return true;
        }
        catch (err) {
            console.error(err);
            return false;
        }
    };

    async getDbConnection() {
        if(this.useStaticDbConnection) {
            return this.staticDbConnection;
        }
        else {
            let dbcon = false;
            try {
                dbcon = await this.pgPool.connect();
            }
            catch(error) {
                console.error("Couldn't connect to database");
                console.error(error);
                return false;
            }
            return dbcon;
        }
    }

    async releaseDbConnection(dbConn) {
        if(this.useStaticDbConnection) {
            //Never release if using static conn
            return true;
        }
        else {
            return dbConn.release();
        }
    }

    async query(sql, params = []) {
        let pgClient = await pgPool.connect();
        let resultData = await pgClient.query(sql, params);
        pgClient.release();
        return resultData;
    }

    run() {
        this.server = this.expressApp.listen(process.env.API_PORT, () =>
            console.log("Webserver started, listening at port", process.env.API_PORT),
        );
    }


    shutdown() {
        this.pgPool.end();
        this.server.close(() => {
            console.log('Server shutdown');
            process.exit(0);
        });
    }
}

module.exports = SeadDataServer;