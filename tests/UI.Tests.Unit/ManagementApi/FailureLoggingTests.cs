// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     FailureLoggingTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Net;

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Testing;

namespace UI.Tests.Unit.ManagementApi;

public class FailureLoggingTests
{
	private static string[] ErrorLines(ManagementApiHarness harness)
	{
		return [.. harness.Logs.GetSnapshot()
			.Where(record => record.Level >= LogLevel.Error)
			.Select(record => record.Message)];
	}

	private static void AssertNamesTheSettingsAndThePermissionTable(string[] errorLines)
	{
		errorLines.Should().NotBeEmpty("the failure is logged at Error");
		errorLines.Should().Contain(line => line.Contains("Auth0:Management:", StringComparison.Ordinal), "the hint names the settings");
		errorLines.Should().Contain(line => line.Contains("README", StringComparison.Ordinal), "the hint points at the README");
		errorLines.Should().Contain(line => line.Contains("permission", StringComparison.OrdinalIgnoreCase), "the hint names the permission table");
	}

	[Fact]
	public async Task Call_TokenExchangeFails_ThrowsAndLogsAnErrorNamingTheSettingsAndThePermissionTable()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.TokenResponder = _ => Auth0Responses.Json(
			"""{"error":"access_denied","error_description":"Unauthorized"}""", HttpStatusCode.Unauthorized);
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>();
		AssertNamesTheSettingsAndThePermissionTable(ErrorLines(harness));
		harness.Handler.ManagementRequests.Should().BeEmpty("without a token no Management API request is sent");
	}

	[Fact]
	public async Task Call_Auth0Returns403_ThrowsAndLogsAnErrorNamingTheSettingsAndThePermissionTable()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError(HttpStatusCode.Forbidden, "Insufficient scope, expected any of: read:roles");

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>();
		AssertNamesTheSettingsAndThePermissionTable(ErrorLines(harness));
	}

	[Fact]
	public async Task Call_Auth0Returns5xxAfterTheRetry_ThrowsAndLogsAnError()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError(HttpStatusCode.InternalServerError, "Internal server error");

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>();
		ErrorLines(harness).Should().NotBeEmpty();
		harness.Handler.ManagementRequests.Should().HaveCount(2, "the SDK retries a 5xx once");
	}

	[Theory]
	[InlineData("token")]
	[InlineData("management")]
	public async Task Call_Auth0IsUnreachable_ThrowsAndLogsAnErrorNamingTheSettings(string failingRequest)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.NoContent());

		if (failingRequest == "token")
		{
			harness.Handler.TokenResponder = _ => throw new HttpRequestException("No such host is known.");
		}
		else
		{
			harness.Handler.Responder = (_, _) => throw new HttpRequestException("No such host is known.");
		}

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>();
		string[] errorLines = ErrorLines(harness);
		errorLines.Should().NotBeEmpty("an unreachable Auth0 is logged at Error");
		errorLines.Should().Contain(line => line.Contains("Auth0:Management:Domain", StringComparison.Ordinal));
	}

	[Fact]
	public async Task Call_TimesOut_ThrowsAndLogsAnError()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Responder = async (_, cancellationToken) =>
		{
			await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);

			return Auth0Responses.NoContent();
		};

		// Act
		Func<Task> act = () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<Exception>();
		ErrorLines(harness).Should().NotBeEmpty();
	}

	[Fact]
	public async Task Call_ExpectedFailure_LogsNothingAtError()
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.RespondWithError(HttpStatusCode.NotFound, "The user does not exist.");

		// Act
		await harness.Api.GetUserAsync(ApiCalls.UserId, Xunit.TestContext.Current.CancellationToken);

		// Assert
		ErrorLines(harness).Should().BeEmpty("a failed Result is an expected outcome, not an error");
	}

	[Theory]
	[InlineData("success")]
	[InlineData("expected failure")]
	[InlineData("token exchange fails")]
	[InlineData("403")]
	[InlineData("5xx")]
	public async Task Call_AnyOutcome_NeverLogsTheAccessTokenOrTheClientSecret(string scenario)
	{
		// Arrange
		using ManagementApiHarness harness = ManagementApiHarness.Create();
		switch (scenario)
		{
			case "success":
				harness.Handler.Respond(request => Auth0Responses.RolesPage(request, ["rol_admin"]));
				break;
			case "expected failure":
				harness.Handler.RespondWithError(HttpStatusCode.NotFound, "The user does not exist.");
				break;
			case "token exchange fails":
				harness.Handler.TokenResponder = _ => Auth0Responses.Json(
					"""{"error":"access_denied","error_description":"Unauthorized"}""", HttpStatusCode.Unauthorized);
				break;
			case "403":
				harness.Handler.RespondWithError(HttpStatusCode.Forbidden, "Insufficient scope");
				break;
			default:
				harness.Handler.RespondWithError(HttpStatusCode.InternalServerError, "Internal server error");
				break;
		}

		// Act
		Func<Task> act = scenario == "expected failure"
			? () => harness.Api.GetUserAsync(ApiCalls.UserId, Xunit.TestContext.Current.CancellationToken)
			: () => harness.Api.ListRolesAsync(Xunit.TestContext.Current.CancellationToken);
		if (scenario is "token exchange fails" or "403" or "5xx")
		{
			// These scenarios throw by design; this test only reads what they logged.
			await act.Should().ThrowAsync<Exception>();
		}
		else
		{
			await act();
		}

		// Assert
		harness.Logs.GetSnapshot().Should().NotBeEmpty();
		harness.LogText.Should().NotContain(line => line.Contains(StubAuth0Handler.AccessToken, StringComparison.Ordinal));
		harness.LogText.Should().NotContain(line => line.Contains(ManagementApiHarness.ClientSecret, StringComparison.Ordinal));
	}
}
