using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TaskFlow.Domain.Entities;
using TaskFlow.Domain.Enums;

namespace TaskFlow.Infrastructure.Persistence;

public class TaskFlowDbContextInitialiser(
    ILogger<TaskFlowDbContextInitialiser> logger,
    TaskFlowDbContext context)
{
    public async Task InitialiseAsync()
    {
        try
        {
            await context.Database.EnsureCreatedAsync();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "An error occurred while initialising the database.");
            throw;
        }
    }

    public async Task SeedAsync()
    {
        if (await context.Projects.AnyAsync())
            return;

        var bugTag = new Tag { Name = "bug" };
        var featureTag = new Tag { Name = "feature" };
        context.Tags.AddRange(bugTag, featureTag);

        var project = new Project
        {
            Name = "TaskFlow Demo",
            Description = "A demonstration project created by the database seeder.",
            Tasks =
            [
                new AppTask
                {
                    Title = "Set up Clean Architecture layers",
                    Status = AppTaskStatus.Done,
                    Priority = Priority.High,
                    Tags = [featureTag]
                },
                new AppTask
                {
                    Title = "Add Blazor Server UI",
                    Status = AppTaskStatus.InProgress,
                    Priority = Priority.High,
                    Tags = [featureTag]
                },
                new AppTask
                {
                    Title = "Write unit tests",
                    Status = AppTaskStatus.Todo,
                    Priority = Priority.Medium,
                    Tags = [bugTag]
                },
            ]
        };

        context.Projects.Add(project);
        await context.SaveChangesAsync();
    }
}
