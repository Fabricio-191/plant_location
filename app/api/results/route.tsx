import { NextResponse } from "next/server";
import prisma from "@/db/prisma";
import { Client, Location, LocationClient } from "@prisma/client";

type HTTPMethod = "GET" | "POST" | "PUT" | "DELETE";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
class WatsonMachineLearning {
	public readonly baseURL = "https://us-south.ml.cloud.ibm.com";
	public readonly version = "2021-05-01";

	public readonly space_id = "e77234d9-92d5-4b3e-bbb7-ae00540f10f1";
	public readonly deploy_id = "e63c96d5-e4f7-4f7f-a4b9-84926055643b";
	public readonly model_asset_id = "46d528d9-8dc8-45ab-bcad-0761fc0ea63f";

	private authToken: { value: string; expiration: number } | null = null;

	private async getAuthToken(): Promise<string> {
		if (this.authToken && this.authToken.expiration > Date.now()) {
			return this.authToken.value;
		}

		const response = await WatsonMachineLearning.makeRequest(
			"POST",
			"https://iam.cloud.ibm.com/identity/token",
			{
				grant_type: "urn:ibm:params:oauth:grant-type:apikey",
				apikey: process.env["IBM_API_KEY"],
			},
		);

		const data = (await response.json()) as {
			access_token: string;
			expiration: number;
		};

		this.authToken = {
			value: data.access_token,
			expiration: data.expiration * 1000,
		};

		return this.authToken.value;
	}

	private async makeRequest(
		method: HTTPMethod,
		path: string,
		params: Record<string, string | number> = {},
		body: Record<string, any> | null = null,
	): Promise<object> {
		params.version = this.version;

		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${await this.getAuthToken()}`,
		};

		const response = await WatsonMachineLearning.makeRequest(
			method,
			this.baseURL + path,
			params,
			headers,
			body,
		);

		return (await response.json()) as object;
	}

	public getDeployments(): Promise<object> {
		return this.makeRequest("GET", "/ml/v4/deployments", {
			space_id: this.space_id,
		});
	}

	public getDeploymentsJobs(): Promise<object> {
		return this.makeRequest("GET", "/ml/v4/deployment_jobs", {
			space_id: this.space_id,
		});
	}

	public getDeploymentJob(job_id: string): Promise<object> {
		return this.makeRequest("GET", `/ml/v4/deployment_jobs/${job_id}`, {
			space_id: this.space_id,
		});
	}

	public waitForJob(
		job_id: string,
		interval = 10000,
		timeout = 120000,
	): Promise<object> {
		return new Promise((resolve, reject) => {
			setTimeout(() => reject("Timeout"), timeout);

			const checkJob = async (): Promise<object> => {
				console.log("Checking job status...");
				const data = await this.getDeploymentJob(job_id);
				// @ts-expect-error
				const status = data.entity.decision_optimization.status.state; // queued, running, completed, failed, canceled
				if (status === "queued" || status === "running") {
					await delay(interval);
					return await checkJob();
				}

				return data;
			};

			resolve(checkJob());
		});
	}

	public createDeploymentJob(
		input_data: unknown = [],
		input_data_references: unknown = [],
	): Promise<object> {
		const body = {
			space_id: this.space_id,
			name: `deploy-job-${new Date().toLocaleString()}`,
			hardware_spec: { name: "S" },
			batch: {},
			deployment: { id: this.deploy_id },
			decision_optimization: {
				solve_parameters: {
					"oaas.logAttachmentName": "log.txt",
					"oaas.logTailEnabled": true,
					"oaas.timeLimit": 120000,
				},
				input_data,
				input_data_references,
				output_data: [{ id: ".*\\.(json|csv)" }],
			},
		};

		return this.makeRequest("POST", "/ml/v4/deployment_jobs", {}, body);
	}

	public static async makeRequest(
		method: HTTPMethod,
		url_string: string,
		params: Record<string, string | number> = {},
		headers: Record<string, string> = {},
		body: Record<string, string> | string | null = null,
	): Promise<Response> {
		const url = new URL(url_string);
		for (const key in params) {
			url.searchParams.append(key, params[key].toString());
		}

		const options: RequestInit = { method, headers };
		if (body !== null) options.body = JSON.stringify(body);

		// console.log(url.toString());
		return await fetch(url.toString(), options);
	}
}

const wml = new WatsonMachineLearning();

const encodeBase64 = (str: string): string =>
	Buffer.from(str).toString("base64");
const decodeBase64 = (str: string): string =>
	Buffer.from(str, "base64").toString("utf-8");

function encodeDat(
	clients: Client[],
	locations: Location[],
	locationClients: LocationClient[],
): string {
	const cost: number[][] = [];

	for (let i = 0; i < clients.length; i++) {
		cost.push([]);
		for (let j = 0; j < locations.length; j++) {
			const lc = locationClients.find(
				(lc) =>
					lc.clientId === clients[i].id &&
					lc.locationId === locations[j].id,
			);
			cost[i].push(lc ? lc.cost : 0);
		}
	}

	return `
nbCustomer = ${clients.length};
nbLocation = ${locations.length};
demand = [${clients.map((c) => c.demand).join(", ")}];
custValues = [${clients.map((c) => c.custValue).join(", ")}];
fixedCost = [${locations.map((l) => l.fixedCost).join(", ")}];
capacity = [${locations.map((l) => l.capacity).join(", ")}];
cost = [${cost.map((x) => `[${x.join(", ")}]`).join(", ")}];`;
}

function decodeDat(str: string): object {
	const obj: Record<string, unknown> = {};

	const variables = str.split(";");
	variables.pop();

	for (const variable of variables) {
		const [name, value] = variable.split("=") as [string, string];
		obj[name.trim()] = JSON.parse(value);
	}

	return obj;
}

const inputDataToJSON = (str: string): string =>
	JSON.stringify(decodeDat(decodeBase64(str)));

export async function POST(request: Request) {
	const { name = "default name" } = await request.json();
	const clients = await prisma.client.findMany({ orderBy: { id: "asc" } });
	const locations = await prisma.location.findMany({
		orderBy: { id: "asc" },
	});
	const locationClient = await prisma.locationClient.findMany({
		orderBy: { id: "asc" },
	});

	const input_data = [
		{
			id: "datos.dat",
			content: encodeBase64(
				encodeDat(clients, locations, locationClient),
			),
		},
	];
	const input_data_references = [
		{
			id: "plant_location.mod",
			type: "data_asset",
			location: {
				href: `/v2/assets/${wml.model_asset_id}?space_id=${wml.space_id}`,
			},
		},
	];

	const data = (await wml.createDeploymentJob(
		input_data,
		input_data_references,
	)) as { metadata: { id: string } };
	const job_id = data.metadata.id;

	console.log("Job ID:", job_id);

	const result = (await wml.waitForJob(job_id, 5000)) as any;
	const opt = result.entity.decision_optimization;

	await prisma.results.create({
		data: {
			name,
			solutionData: decodeBase64(opt.output_data[0].content),
			inputdata: inputDataToJSON(opt.input_data[0].content),
			console: opt.solve_state.latest_engine_activity.join("\n"),
			createdAt: new Date(result.metadata.created_at),
			maxMemory: Number(opt.solve_state.details["STAT.job.memoryPeakKB"]),
			processingTime: Number(
				opt.solve_state.details["STAT.job.modelProcessingMs"],
			),
			statusSolution: opt.solve_state.solve_status,
		},
	});

	return NextResponse.json({ result });
}

export async function GET() {
	try {
		const results = await prisma.results.findMany({
			orderBy: { id: "desc" },
		});
		return NextResponse.json({ results });
	} catch (error) {
		return NextResponse.json({ error });
	}
}
